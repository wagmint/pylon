import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getActiveSessions } from "../discovery/sessions.js";

// ─── In-memory blocked session store ────────────────────────────────────────

export interface BlockedInfo {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  blockedAt: number;
  /** JSONL file size (bytes) when the hook was received. Used to detect user response. */
  snapshotSize: number;
}

export const blockedSessions = new Map<string, BlockedInfo>();

/** Max age before a blocked entry is auto-purged (safety net for crashed sessions) */
const BLOCKED_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Auto-clear stale blocked entries. Called each ticker cycle before buildDashboardState().
 * - Clears if the session's JSONL file has grown since the hook was received (user responded)
 * - Purges entries for sessions no longer active
 * - Purges entries older than TTL
 */
export function clearStaleBlocked(): void {
  if (blockedSessions.size === 0) return;

  const now = Date.now();
  const activeSessions = getActiveSessions();
  const activeIds = new Set(activeSessions.map(s => s.id));
  const activeByIdMap = new Map(activeSessions.map(s => [s.id, s]));

  for (const [sessionId, info] of blockedSessions) {
    // Purge if session is no longer active
    if (!activeIds.has(sessionId)) {
      blockedSessions.delete(sessionId);
      continue;
    }

    // Purge if older than TTL
    if (now - info.blockedAt > BLOCKED_TTL_MS) {
      blockedSessions.delete(sessionId);
      continue;
    }

    // Clear if JSONL file has grown since hook receipt (user responded).
    // File size is immune to the mtime race: Claude Code may touch the file
    // after firing the hook (updating mtime), but a user response always
    // appends a full tool_result JSON line — measurable growth.
    const session = activeByIdMap.get(sessionId);
    if (session) {
      try {
        const currentSize = statSync(session.path).size;
        if (info.snapshotSize > 0 && currentSize > info.snapshotSize) {
          blockedSessions.delete(sessionId);
        }
      } catch {
        // File gone — purge
        blockedSessions.delete(sessionId);
      }
    }
  }
}

// ─── Auto-install Claude Code hooks ─────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");

const HOOK_MARKER = "localhost:7433/api/hooks/blocked";

const HEXDECK_HOOK = {
  matcher: ".*",
  hooks: [
    {
      type: "command",
      command: `curl -s -X POST http://localhost:7433/api/hooks/blocked -H 'Content-Type: application/json' -d "$(cat)" &>/dev/null &`,
      timeout: 5,
    },
  ],
};

/** Hook event types that mean "agent is waiting for user action" */
const HOOK_EVENTS = ["PermissionRequest", "Stop"] as const;

/**
 * Ensure hexdeck hooks are installed in ~/.claude/settings.json.
 * Hooks into PermissionRequest (tool approvals) and Stop (plan approval, idle prompt).
 * Preserves all existing user hooks. Only runs once at server startup.
 */
export function ensureHooks(): void {
  try {
    // Ensure directory exists
    if (!existsSync(CLAUDE_DIR)) {
      mkdirSync(CLAUDE_DIR, { recursive: true });
    }

    // Read or initialize settings
    let settings: Record<string, unknown> = {};
    if (existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      } catch {
        // Corrupt file — start with empty object, preserve file by writing back
        settings = {};
      }
    }

    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown>;

    let dirty = false;

    for (const eventType of HOOK_EVENTS) {
      if (!Array.isArray(hooks[eventType])) {
        hooks[eventType] = [];
      }
      const eventHooks = hooks[eventType] as unknown[];

      // Check if hexdeck hook already exists for this event
      const alreadyInstalled = eventHooks.some((entry: unknown) => {
        if (!entry || typeof entry !== "object") return false;
        const e = entry as Record<string, unknown>;
        if (!Array.isArray(e.hooks)) return false;
        return (e.hooks as unknown[]).some((h: unknown) => {
          if (!h || typeof h !== "object") return false;
          const hk = h as Record<string, unknown>;
          return typeof hk.command === "string" && hk.command.includes(HOOK_MARKER);
        });
      });

      if (!alreadyInstalled) {
        eventHooks.push(HEXDECK_HOOK);
        dirty = true;
      }
    }

    if (!dirty) return;

    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log("Hexdeck: installed hooks in ~/.claude/settings.json");
  } catch (err) {
    console.error("Hexdeck: failed to install hooks:", err);
  }
}

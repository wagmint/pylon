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
}

export const blockedSessions = new Map<string, BlockedInfo>();

/** Max age before a blocked entry is auto-purged (safety net for crashed sessions) */
const BLOCKED_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Auto-clear stale blocked entries. Called each ticker cycle before buildDashboardState().
 * - Clears if the session's JSONL file mtime > blockedAt (user responded)
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

    // Clear if JSONL file was modified after blockedAt (user responded to permission)
    const session = activeByIdMap.get(sessionId);
    if (session) {
      try {
        const mtime = statSync(session.path).mtimeMs;
        if (mtime > info.blockedAt) {
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

/**
 * Ensure the PermissionRequest hook is installed in ~/.claude/settings.json.
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

    // Navigate to hooks.PermissionRequest
    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown>;

    if (!Array.isArray(hooks.PermissionRequest)) {
      hooks.PermissionRequest = [];
    }
    const permHooks = hooks.PermissionRequest as unknown[];

    // Check if hexdeck hook already exists
    const alreadyInstalled = permHooks.some((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      if (!Array.isArray(e.hooks)) return false;
      return (e.hooks as unknown[]).some((h: unknown) => {
        if (!h || typeof h !== "object") return false;
        const hk = h as Record<string, unknown>;
        return typeof hk.command === "string" && hk.command.includes(HOOK_MARKER);
      });
    });

    if (alreadyInstalled) return;

    // Append our hook entry
    permHooks.push(HEXDECK_HOOK);

    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log("Hexdeck: installed PermissionRequest hook in ~/.claude/settings.json");
  } catch (err) {
    console.error("Hexdeck: failed to install hooks:", err);
  }
}

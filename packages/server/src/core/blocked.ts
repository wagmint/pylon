import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
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

// ─── Pending decision store (for permission-gate long-poll) ─────────────────

export interface PendingDecision {
  resolve: (decision: "allow" | "deny" | "prompt") => void;
  timer: ReturnType<typeof setTimeout>;
}

export const pendingDecisions = new Map<string, PendingDecision>();
const GATE_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Create a pending decision for a session. Returns a promise that resolves
 * when the user approves/denies from the UI, or times out as "prompt".
 * If a previous pending decision exists for this session, it resolves as "prompt".
 */
export function createPendingDecision(sessionId: string): Promise<"allow" | "deny" | "prompt"> {
  // If there's already a pending decision, resolve the old one as "prompt"
  const existing = pendingDecisions.get(sessionId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve("prompt");
    pendingDecisions.delete(sessionId);
  }

  return new Promise<"allow" | "deny" | "prompt">((resolve) => {
    const timer = setTimeout(() => {
      pendingDecisions.delete(sessionId);
      resolve("prompt");
    }, GATE_TIMEOUT_MS);

    pendingDecisions.set(sessionId, { resolve, timer });
  });
}

/**
 * Resolve a pending decision from the UI (approve/deny button click).
 * Returns true if a pending decision was found and resolved.
 */
export function resolveDecision(sessionId: string, decision: "allow" | "deny"): boolean {
  const pending = pendingDecisions.get(sessionId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingDecisions.delete(sessionId);
  pending.resolve(decision);
  return true;
}

/** Whether a permission-gate decision is currently pending for this session. */
export function hasPendingDecision(sessionId: string): boolean {
  return pendingDecisions.has(sessionId);
}

/**
 * Clear blocked state for a session and release any pending gate wait as "prompt".
 * Used when the session resumes through terminal-side approval/interaction.
 */
export function clearBlockedSession(sessionId: string): void {
  blockedSessions.delete(sessionId);
  const pending = pendingDecisions.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.resolve("prompt");
  pendingDecisions.delete(sessionId);
}

/** Max age before a blocked entry is auto-purged (safety net for crashed sessions) */
const BLOCKED_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Auto-clear stale blocked entries. Called each ticker cycle before buildDashboardState().
 * - Clears when appended JSONL data shows unblock evidence (tool_result or user message)
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
    let shouldClear = false;

    // Purge if session is no longer active
    if (!activeIds.has(sessionId)) {
      shouldClear = true;
    }

    // Purge if older than TTL
    if (!shouldClear && now - info.blockedAt > BLOCKED_TTL_MS) {
      shouldClear = true;
    }

    // Clear only when appended transcript data contains unblock evidence.
    // Plain file growth alone is not reliable: Claude Code may append
    // internal/status lines while still waiting for user input.
    if (!shouldClear) {
      const session = activeByIdMap.get(sessionId);
      if (session) {
        try {
          const currentSize = statSync(session.path).size;
          if (
            info.snapshotSize > 0
            && currentSize > info.snapshotSize
            && hasUnblockEvidence(session.path, info.snapshotSize)
          ) {
            shouldClear = true;
          }
        } catch {
          // File gone — purge
          shouldClear = true;
        }
      }
    }

    if (shouldClear) {
      clearBlockedSession(sessionId);
    }
  }
}

function hasUnblockEvidence(transcriptPath: string, snapshotSize: number): boolean {
  try {
    const buf = readFileSync(transcriptPath);
    if (snapshotSize <= 0 || buf.length <= snapshotSize) return false;
    const appended = buf.subarray(snapshotSize).toString("utf-8");
    if (!appended.trim()) return false;

    const lines = appended.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        // Clear only on explicit unblock evidence from the transcript:
        // user follow-up or tool result/rejection output.
        // (assistant/tool_use lines can appear while still awaiting approval)
        if (
          lineContainsToolResult(parsed)
          || lineContainsUserMessage(parsed)
        ) {
          return true;
        }
      } catch {
        // Ignore malformed lines in tail append section.
      }
    }
  } catch {
    // If we cannot inspect the transcript, keep blocked until TTL/session end.
    return false;
  }
  return false;
}

function lineContainsUserMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;

  if (obj.role === "user") return true;
  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    if (msg.role === "user") return true;
  }

  return false;
}

function lineContainsToolResult(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;

  const message = obj.message && typeof obj.message === "object"
    ? (obj.message as Record<string, unknown>)
    : obj;
  const content = message.content;
  if (!Array.isArray(content)) return false;

  return content.some((block) => (
    !!block
    && typeof block === "object"
    && (block as Record<string, unknown>).type === "tool_result"
  ));
}

// ─── Extract key detail from tool input (command, file path, URL) ────────────

export function extractToolDetail(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case "Bash": {
      const cmd = toolInput.command;
      return typeof cmd === "string" ? cmd : undefined;
    }
    case "Edit":
    case "Write": {
      const fp = toolInput.file_path;
      return typeof fp === "string" ? fp : undefined;
    }
    case "WebFetch": {
      const url = toolInput.url;
      return typeof url === "string" ? url : undefined;
    }
    default:
      return undefined;
  }
}

// ─── Describe blocked tool for UI ────────────────────────────────────────────

export function describeBlockedTool(info: BlockedInfo): string {
  const { toolName, toolInput } = info;

  switch (toolName) {
    case "Bash": {
      const desc = toolInput.description;
      if (typeof desc === "string" && desc.length > 0) return desc;
      return "Run a command";
    }
    case "Edit": {
      const filePath = toolInput.file_path;
      if (typeof filePath === "string") return `Edit ${basename(filePath)}`;
      return "Edit a file";
    }
    case "Write": {
      const filePath = toolInput.file_path;
      if (typeof filePath === "string") return `Write ${basename(filePath)}`;
      return "Write a file";
    }
    case "WebFetch": {
      const url = toolInput.url;
      if (typeof url === "string") {
        try { return `Fetch ${new URL(url).hostname}`; } catch { /* fall through */ }
      }
      return "Fetch a URL";
    }
    case "WebSearch":
      return "Web search";
    case "AskUserQuestion":
      return "Answering a question";
    case "ExitPlanMode":
      return "Plan approval";
    default:
      return `Approve ${toolName}`;
  }
}

// ─── Auto-install Claude Code hooks ─────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const HEXDECK_DIR = join(homedir(), ".hexdeck");
const HOOKS_DIR = join(HEXDECK_DIR, "hooks");

const HOOK_MARKER = "localhost:7433/api/hooks";
const OLD_BLOCKED_MARKER = "localhost:7433/api/hooks/blocked";
const GATE_MARKER = "permission-gate.sh";

/** Fire-and-forget notification hook (PreToolUse: AskUserQuestion, ExitPlanMode) */
const NOTIFICATION_HOOK = {
  matcher: "AskUserQuestion|ExitPlanMode",
  hooks: [
    {
      type: "command",
      command: `curl -s -X POST http://localhost:7433/api/hooks/blocked -H 'Content-Type: application/json' -d @- &>/dev/null`,
      timeout: 5,
    },
  ],
};

/** Fire-and-forget unblocked notification (PostToolUse) */
const UNBLOCKED_HOOK = {
  matcher: ".*",
  hooks: [
    {
      type: "command",
      command: `curl -s -X POST http://localhost:7433/api/hooks/unblocked -H 'Content-Type: application/json' -d @- &>/dev/null`,
      timeout: 5,
    },
  ],
};

/** Permission gate hook (PermissionRequest — long-poll via script) */
const PERMISSION_GATE_HOOK = {
  matcher: ".*",
  hooks: [
    {
      type: "command",
      command: `bash ${HOOKS_DIR}/permission-gate.sh`,
      timeout: 130,
    },
  ],
};

const PERMISSION_GATE_SCRIPT = `#!/bin/bash
# Hexdeck permission gate — holds connection until UI approve/deny or timeout
INPUT=$(cat)
RESPONSE=$(echo "$INPUT" | curl -s --max-time 125 \\
  -X POST http://localhost:7433/api/hooks/permission-gate \\
  -H 'Content-Type: application/json' -d @- 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  exit 0
fi
echo "$RESPONSE"
`;

/**
 * Write the permission-gate.sh script to ~/.hexdeck/hooks/
 */
function ensureGateScript(): void {
  if (!existsSync(HOOKS_DIR)) {
    mkdirSync(HOOKS_DIR, { recursive: true });
  }
  const scriptPath = join(HOOKS_DIR, "permission-gate.sh");
  // Always overwrite to pick up any script changes
  writeFileSync(scriptPath, PERMISSION_GATE_SCRIPT, { mode: 0o755 });
}

/**
 * Check if a hook entry contains a hexdeck command (by marker substring).
 */
function hasHexdeckCommand(entry: unknown, marker: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (!Array.isArray(e.hooks)) return false;
  return (e.hooks as unknown[]).some((h: unknown) => {
    if (!h || typeof h !== "object") return false;
    const hk = h as Record<string, unknown>;
    return typeof hk.command === "string" && (hk.command as string).includes(marker);
  });
}

/**
 * Ensure hexdeck hooks are installed in ~/.claude/settings.json.
 *
 * - PermissionRequest: permission-gate hook (long-poll for remote approve/deny)
 * - PreToolUse: fire-and-forget notification for AskUserQuestion/ExitPlanMode
 * - PostToolUse: clear blocked state quickly when tool actually runs
 * - Stop: removed (not useful)
 *
 * Migrates old fire-and-forget PermissionRequest hooks to the new gate hook.
 */
export function ensureHooks(): void {
  try {
    // Ensure directories exist
    if (!existsSync(CLAUDE_DIR)) {
      mkdirSync(CLAUDE_DIR, { recursive: true });
    }
    ensureGateScript();

    // Read or initialize settings
    let settings: Record<string, unknown> = {};
    if (existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      } catch {
        settings = {};
      }
    }

    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown>;

    let dirty = false;

    // ── PermissionRequest: install gate hook (replace old fire-and-forget) ──
    if (!Array.isArray(hooks["PermissionRequest"])) {
      hooks["PermissionRequest"] = [];
    }
    const permHooks = hooks["PermissionRequest"] as unknown[];

    // Remove old fire-and-forget hexdeck hooks from PermissionRequest
    for (let i = permHooks.length - 1; i >= 0; i--) {
      if (hasHexdeckCommand(permHooks[i], OLD_BLOCKED_MARKER)) {
        permHooks.splice(i, 1);
        dirty = true;
      }
    }

    // Check if gate hook is already installed
    const gateInstalled = permHooks.some((entry) => hasHexdeckCommand(entry, GATE_MARKER));
    if (!gateInstalled) {
      permHooks.push(PERMISSION_GATE_HOOK);
      dirty = true;
    }

    // ── Stop: remove hexdeck hooks (not useful) ──
    if (Array.isArray(hooks["Stop"])) {
      const stopHooks = hooks["Stop"] as unknown[];
      for (let i = stopHooks.length - 1; i >= 0; i--) {
        if (hasHexdeckCommand(stopHooks[i], HOOK_MARKER)) {
          stopHooks.splice(i, 1);
          dirty = true;
        }
      }
    }

    // ── PreToolUse: fire-and-forget for interactive tools ──
    if (!Array.isArray(hooks["PreToolUse"])) {
      hooks["PreToolUse"] = [];
    }
    const preToolHooks = hooks["PreToolUse"] as unknown[];
    let interactiveHookInstalled = false;
    for (const entry of preToolHooks) {
      if (!hasHexdeckCommand(entry, OLD_BLOCKED_MARKER)) continue;

      interactiveHookInstalled = true;
      const e = entry as Record<string, unknown>;
      const matcher = typeof e.matcher === "string" ? e.matcher : "";
      const coversAsk = matcher.includes("AskUserQuestion");
      const coversExitPlan = matcher.includes("ExitPlanMode");
      if (!coversAsk || !coversExitPlan) {
        e.matcher = NOTIFICATION_HOOK.matcher;
        dirty = true;
      }
      break;
    }
    if (!interactiveHookInstalled) {
      preToolHooks.push(NOTIFICATION_HOOK);
      dirty = true;
    }

    // ── PostToolUse: clear stale blocked state on resumed execution ──
    if (!Array.isArray(hooks["PostToolUse"])) {
      hooks["PostToolUse"] = [];
    }
    const postToolHooks = hooks["PostToolUse"] as unknown[];
    const postInstalled = postToolHooks.some((entry) => hasHexdeckCommand(entry, "api/hooks/unblocked"));
    if (!postInstalled) {
      postToolHooks.push(UNBLOCKED_HOOK);
      dirty = true;
    }

    if (!dirty) return;

    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log("Hexdeck: installed hooks in ~/.claude/settings.json");
  } catch (err) {
    console.error("Hexdeck: failed to install hooks:", err);
  }
}

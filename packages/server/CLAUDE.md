# Hexdeck Server — Agent Guide

## Architecture

Hexdeck monitors Claude Code sessions via JSONL transcript files discovered through `pgrep` + `lsof`. A 1-second ticker builds `DashboardState` and streams it via SSE to the menubar widget and dashboard UI.

Key flow: Claude Code hooks → HTTP endpoints → in-memory Maps → `buildDashboardState()` → SSE → UI

## Critical: Agent Status Detection Edge Cases

The status detection system (`src/core/dashboard.ts`, `src/core/blocked.ts`) has many subtle edge cases discovered through production use. **Read this section before modifying any status, idle, blocked, or hook logic.**

### 1. Stop Hook Grace Period (`blocked.ts`)

The Stop hook fires when Claude's turn completes. `markSessionStopped()` records wall-clock time. But Claude Code may rewrite the JSONL file *after* the hook fires (e.g., `/compact` rewrites the transcript). Without a grace period, the mtime change would clear the stopped state and the agent would appear "busy" for up to `IDLE_THRESHOLD_MS`.

- `STOP_GRACE_MS = 5000` — tolerates post-hook file rewrites
- `isSessionStopped()` only clears stopped state if `file.mtime > stoppedAt + 5s`
- If grace period is too large (>10s), real new turns get masked as "still stopped"
- If removed, agents flicker between idle/busy during compaction

### 2. Two-Layer Idle Detection (`dashboard.ts`)

Idle is detected by two mechanisms in priority order:

1. **Stop hook** (instant) — `isSessionStopped()` checked first
2. **mtime fallback** (`IDLE_THRESHOLD_MS = 120s`) — if Stop hook didn't fire (network issue, crash, command that doesn't trigger hooks)

Both are needed. Stop hook alone breaks on network failure. mtime alone has 2-minute lag.

### 3. Stale Blocked Clearing (`blocked.ts: clearStaleBlocked`)

Blocked entries are cleared by three independent mechanisms:

1. Session process died (`getActiveSessions()` check)
2. Entry older than 10 minutes (`BLOCKED_TTL_MS`)
3. Transcript file grew AND contains **unblock evidence** (tool_result or user message in the appended bytes)

File growth alone is NOT reliable — Claude Code appends assistant messages while still blocked. Only `tool_result` or `user` role lines count as unblock evidence. The check inspects only the delta from `snapshotSize` to current size.

Clearing is **all-or-nothing per session**: if any blocked entry for a session is stale, ALL are cleared.

### 4. Permission Gate Timeout vs. Bash Script Timeout

- Server-side: `GATE_TIMEOUT_MS = 120s` → resolves as `"prompt"` (falls back to local dialog)
- Bash script: `curl --max-time 125s` → 5s buffer so server timeout wins
- Timeout MUST resolve as `"prompt"`, never `"allow"` — auto-approval on timeout would be a security issue
- Timeout callback clears BOTH `pendingDecisions` AND `blockedSessions` entries

### 5. Parallel Tool Calls (`requestId` keying)

Claude Code can fire N parallel tool calls. Each hook invocation gets a unique `requestId` (UUID). Both `blockedSessions` and `pendingDecisions` are keyed by `requestId`, not `sessionId`.

- `createPendingDecision()` does NOT kill existing pending for same session
- `resolveAllDecisions(sessionId)` batch-resolves ALL pending for that session ("Approve All" semantics)
- Each requestId has its own timer and Promise
- UI calls `/api/sessions/:id/decide` which resolves all — individual per-tool approval is not supported

### 6. Unblocked Hook vs. Pending Decision Race (`server/index.ts`)

PostToolUse hook fires `/api/hooks/unblocked` when a tool runs. Two race conditions:

1. **Tool runs before gate response** → unblocked fires, but pending promise still waiting → skip unblocked (check `hasPendingDecision`)
2. **Gate response before unblocked** → decision already resolved, blocked already cleared → skip unblocked (check `hasBlockedSession`)

Removing the `hasPendingDecision` guard causes double-clearing. Both guards are required.

### 7. Status Priority Chain (`determineAgentStatus`)

Checked in this order — first match wins:

1. **Blocked** (permission gate) — highest priority
2. **Conflict** (file collision with another session)
3. **Warning** (2+ of last 3 turns have errors)
4. **Busy vs. Idle** (Stop hook → mtime fallback)

An agent can be both blocked AND in collision. Blocked takes priority because the user needs to act on it. Reordering breaks the UX.

### 8. Favicon Severity (`menubar/src/lib/alerts.ts: worstSeverity`)

Priority: red > blue > yellow > green > grey

- **Green** requires `status === "busy"` (not "idle"). If all agents are idle, favicon is grey.
- Previously had a bug where `"idle"` triggered green — fixed by checking `hasBusy` specifically.

### 9. Feed Events: Transient vs. Permanent (`feed.ts`)

- Turn-based events (commits, errors, plans) are **permanent** — added once with stable IDs
- Blocked/stall/idle events are **transient** — deleted and recreated each ticker cycle
- Must delete old transient events before re-adding, or they persist when the state clears
- Multiple blocked requests per session are grouped into one feed event

### 10. Accumulator Survival Across Compaction (`dashboard.ts`)

When Claude Code compacts context, it rewrites the JSONL with fewer turns. Detected by `acc.totalTurns > parsed.turns.length`. On detection, accumulator stats are merged into current parse to preserve historical metrics. Without this, stats reset every time context is compacted.

### 11. Stall Detection Thresholds (`dashboard.ts`)

Three different time windows, checked only for agents with "active work" (drafting plans or pending tasks):

- `IDLE_MS = 5 min` — below this, no stall check at all
- `STALL_WARN_MS = 15 min` → elevated risk
- `STALL_CRIT_MS = 45 min` → critical risk

Agents with no active work are marked "idle", not "stalled". These are different concepts.

## Hook Types

| Hook Event | Behavior | Endpoint |
|---|---|---|
| `PermissionRequest` | **Blocking long-poll** via bash script. Holds HTTP connection until UI decision or 120s timeout. | `/api/hooks/permission-gate` |
| `PreToolUse` | Fire-and-forget notification for AskUserQuestion/ExitPlanMode only. | `/api/hooks/blocked` |
| `PostToolUse` | Fire-and-forget cleanup. Clears blocked state when tool actually runs. | `/api/hooks/unblocked` |
| `Stop` | Fire-and-forget. Marks session idle immediately when turn completes. | `/api/hooks/stopped` |

## Testing Changes

When modifying status detection logic, verify these scenarios:

1. **Normal turn end** → agent goes idle immediately (Stop hook)
2. **`/compact` command** → agent goes idle within 5s (Stop hook + grace period)
3. **Stop hook network failure** → agent goes idle within 120s (mtime fallback)
4. **4 parallel WebFetch** → all 4 show in UI, "Approve All" resolves all
5. **Approve from UI** → all pending promises resolve, hook scripts return to Claude
6. **120s timeout** → falls back to local dialog ("prompt"), no auto-approval
7. **Session process dies** → blocked entries cleared on next ticker
8. **All agents idle** → favicon is grey, not green
9. **Context compaction** → stats preserved via accumulator merge
10. **Agent blocked + file collision** → shows as "blocked" (not "conflict")

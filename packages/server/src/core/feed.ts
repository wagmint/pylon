import type { ParsedSession, FeedEvent, TurnNode } from "../types/index.js";
import type { SpinningSignal } from "../types/dashboard.js";
import { formatIdleDuration } from "./duration.js";
import { blockedSessions, type BlockedInfo } from "./blocked.js";

// ─── In-memory feed state ──────────────────────────────────────────────────

const MAX_FEED_SIZE = 200;

/** Append-only feed log, keyed by event ID */
const feedLog = new Map<string, FeedEvent>();

/**
 * Build a unified feed of events from all sessions.
 * Maintains an append-only in-memory log with a moving window.
 * Turn-based events are re-derived each cycle (stable IDs prevent duplicates).
 */
export function buildFeed(
  sessions: ParsedSession[],
  labelMap?: Map<string, string>,
  activeSessionIds?: Set<string>,
  operatorMap?: Map<string, string>,
  stalledSessionIds?: Set<string>,
  spinningBySession?: Map<string, { signals: SpinningSignal[]; turns: TurnNode[] }>,
  planTaskKeys?: Set<string>,
): FeedEvent[] {
  /** Resolve operatorId for a session */
  const opId = (sessionId: string) => operatorMap?.get(sessionId) ?? "self";

  // 1. Derive turn-based events — stable IDs mean they're only added once
  for (const session of sessions) {
    const sessionId = session.session.id;
    const projectPath = session.session.projectPath;
    const label = labelMap?.get(sessionId) ?? sessionId.slice(0, 8);
    const operatorId = opId(sessionId);

    addEvent({
      id: `start-${sessionId}`,
      type: "start",
      timestamp: new Date(session.session.createdAt),
      agentLabel: label,
      sessionId,
      projectPath,
      operatorId,
      message: `Session started in ${projectName(projectPath)}`,
    });

    for (let i = 0; i < session.turns.length; i++) {
      const turn = session.turns[i];
      const timestamp = turn.timestamp;

      if (turn.hasCommit) {
        addEvent({
          id: `commit-${sessionId}-${turn.index}`,
          type: "commit",
          timestamp,
          agentLabel: label,
          sessionId,
          projectPath,
          operatorId,
          message: turn.commitMessage
            ? `Committed: ${turn.commitMessage}`
            : `Committed changes to ${turn.filesChanged.length} file(s)`,
          commitSha: turn.commitSha ?? undefined,
          commitFiles: turn.filesChanged.length > 0 ? turn.filesChanged : undefined,
        });
      }

      if (turn.hasPush) {
        addEvent({
          id: `push-${sessionId}-${turn.index}`,
          type: "push",
          timestamp,
          agentLabel: label,
          sessionId,
          projectPath,
          operatorId,
          message: `Pushed changes`,
        });
      }

      if (turn.hasCompaction) {
        addEvent({
          id: `compaction-${sessionId}-${turn.index}`,
          type: "compaction",
          timestamp,
          agentLabel: label,
          sessionId,
          projectPath,
          operatorId,
          message: "Context compacted",
        });
      }

      if (turn.category === "interruption") {
        addEvent({
          id: `interrupted-${sessionId}-${turn.index}`,
          type: "idle",
          timestamp,
          agentLabel: label,
          sessionId,
          projectPath,
          operatorId,
          message: "Turn interrupted by user",
        });
      }

      if (turn.hasPlanStart) {
        addEvent({
          id: `plan-start-${sessionId}-${turn.index}`,
          type: "plan_started",
          timestamp,
          agentLabel: label,
          sessionId,
          projectPath,
          operatorId,
          message: "Entered plan mode",
        });
      }

      if (turn.hasPlanEnd && !turn.planRejected) {
        addEvent({
          id: `plan-approved-${sessionId}-${turn.index}`,
          type: "plan_approved",
          timestamp,
          agentLabel: label,
          sessionId,
          projectPath,
          operatorId,
          message: `Plan approved${turn.planMarkdown ? ": " + extractPlanTitle(turn.planMarkdown) : ""}`,
        });
      }

      for (const tu of turn.taskUpdates) {
        if (tu.status === "completed") {
          // Skip tasks that belong to a plan — they're shown in "Recently Completed" instead
          if (planTaskKeys?.has(`${sessionId}:${tu.taskId}`)) continue;
          const task = findTaskSubject(session, tu.taskId);
          addEvent({
            id: `task-done-${sessionId}-${tu.taskId}-${turn.index}`,
            type: "task_completed",
            timestamp,
            agentLabel: label,
            sessionId,
            projectPath,
            operatorId,
            message: task ?? `task #${tu.taskId}`,
          });
        }
      }
    }
  }

  // 1b. Inject "session_ended" events for inactive sessions
  if (activeSessionIds) {
    for (const session of sessions) {
      const sessionId = session.session.id;
      if (!activeSessionIds.has(sessionId)) {
        const label = labelMap?.get(sessionId) ?? sessionId.slice(0, 8);
        addEvent({
          id: `session-ended-${sessionId}`,
          type: "session_ended",
          timestamp: new Date(session.session.modifiedAt),
          agentLabel: label,
          sessionId,
          projectPath: session.session.projectPath,
          operatorId: opId(sessionId),
          message: "Session ended",
        });
      }
    }
  }

  // 1c. Stall / idle events — active sessions with extended silence
  //     These are transient: clear previous entries each cycle, re-add only if still silent.
  const SILENCE_FEED_MS = 5 * 60 * 1000;
  if (activeSessionIds) {
    // Remove stale idle/stall entries so they disappear when session resumes
    for (const sessionId of activeSessionIds) {
      feedLog.delete(`idle-${sessionId}`);
      feedLog.delete(`stall-${sessionId}`);
    }
    const nowMs = Date.now();
    for (const session of sessions) {
      const sessionId = session.session.id;
      if (!activeSessionIds.has(sessionId)) continue;
      const silenceMs = nowMs - session.session.modifiedAt.getTime();
      if (silenceMs > SILENCE_FEED_MS) {
        const label = labelMap?.get(sessionId) ?? sessionId.slice(0, 8);
        const isStalled = stalledSessionIds?.has(sessionId) ?? false;
        feedLog.set(`${isStalled ? "stall" : "idle"}-${sessionId}`, {
          id: `${isStalled ? "stall" : "idle"}-${sessionId}`,
          type: isStalled ? "stall" : "idle",
          timestamp: new Date(session.session.modifiedAt),
          agentLabel: label,
          sessionId,
          projectPath: session.session.projectPath,
          operatorId: opId(sessionId),
          message: isStalled
            ? `Stalled: no activity for ${formatIdleDuration(silenceMs)}`
            : `Idle for ${formatIdleDuration(silenceMs)}`,
        });
      }
    }
  }

  // 1d. Blocked events — transient, same pattern as stall/idle.
  //     Group by sessionId so we get one feed event per session even with parallel requests.
  if (activeSessionIds) {
    // Clear stale blocked entries each cycle
    for (const sessionId of activeSessionIds) {
      feedLog.delete(`blocked-${sessionId}`);
    }
    // Group blocked entries by session
    const blockedBySession = new Map<string, BlockedInfo[]>();
    for (const info of blockedSessions.values()) {
      if (!activeSessionIds.has(info.sessionId)) continue;
      let arr = blockedBySession.get(info.sessionId);
      if (!arr) { arr = []; blockedBySession.set(info.sessionId, arr); }
      arr.push(info);
    }
    for (const [sessionId, infos] of blockedBySession) {
      const label = labelMap?.get(sessionId) ?? sessionId.slice(0, 8);
      const session = sessions.find(s => s.session.id === sessionId);
      const earliest = infos.reduce((min, i) => i.blockedAt < min ? i.blockedAt : min, infos[0].blockedAt);
      let message: string;
      if (infos.length === 1) {
        const info = infos[0];
        message = info.toolName && info.toolName !== "unknown"
          ? `Waiting for permission: ${info.toolName}`
          : "Waiting for user input";
      } else {
        const toolNames = [...new Set(infos.map(i => i.toolName).filter(t => t !== "unknown"))];
        message = toolNames.length > 0
          ? `Waiting for permission: ${infos.length} tools (${toolNames.join(", ")})`
          : `Waiting for permission: ${infos.length} tools`;
      }
      feedLog.set(`blocked-${sessionId}`, {
        id: `blocked-${sessionId}`,
        type: "blocked",
        timestamp: new Date(earliest),
        agentLabel: label,
        sessionId,
        projectPath: session?.session.projectPath ?? "",
        operatorId: opId(sessionId),
        message,
      });
    }
  }

  // 1e. Spinning events — transient, same pattern as stall/idle/blocked.
  if (activeSessionIds && spinningBySession) {
    // Clear stale spinning entries each cycle
    for (const sessionId of activeSessionIds) {
      feedLog.delete(`spinning-${sessionId}`);
    }
    for (const [sessionId, { signals, turns }] of spinningBySession) {
      if (!activeSessionIds.has(sessionId)) continue;
      // Only real spinning patterns (not stalled/idle which are handled separately)
      const realSignals = signals.filter(s =>
        s.pattern === "error_loop" || s.pattern === "file_churn" || s.pattern === "repeated_tool" || s.pattern === "stuck"
      );
      if (realSignals.length === 0) continue;

      const label = labelMap?.get(sessionId) ?? sessionId.slice(0, 8);
      const session = sessions.find(s => s.session.id === sessionId);
      const message = buildSpinningMessage(realSignals, turns);

      feedLog.set(`spinning-${sessionId}`, {
        id: `spinning-${sessionId}`,
        type: "spinning",
        timestamp: new Date(),
        agentLabel: label,
        sessionId,
        projectPath: session?.session.projectPath ?? "",
        operatorId: opId(sessionId),
        message,
      });
    }
  }

  // 2. Trim to moving window (drop oldest)
  if (feedLog.size > MAX_FEED_SIZE) {
    const sorted = [...feedLog.entries()].sort(
      (a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime()
    );
    const toRemove = sorted.slice(0, feedLog.size - MAX_FEED_SIZE);
    for (const [id] of toRemove) {
      feedLog.delete(id);
    }
  }

  // 3. Return sorted newest-first
  return [...feedLog.values()].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
  );
}

/** Add event to feedLog if not already present (append-only). */
function addEvent(event: FeedEvent): void {
  if (!feedLog.has(event.id)) {
    feedLog.set(event.id, event);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function projectName(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

function extractPlanTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)/m);
  return match ? match[1].slice(0, 60) : "implementation plan";
}

function findTaskSubject(session: ParsedSession, taskId: string): string | null {
  for (const turn of session.turns) {
    const tc = turn.taskCreates.find(t => t.taskId === taskId);
    if (tc) return tc.subject;
  }
  return null;
}

/**
 * Build a human-readable spinning message from signals + turns.
 * Picks the most specific signal and enriches with turn data.
 */
function buildSpinningMessage(signals: SpinningSignal[], turns: TurnNode[]): string {
  const recent = turns.slice(-10);
  const parts: string[] = [];

  for (const signal of signals) {
    switch (signal.pattern) {
      case "error_loop": {
        // Collect error descriptions from recent turns
        const errorDescs: string[] = [];
        for (const turn of recent) {
          if (turn.hasError) {
            for (const item of turn.sections.corrections.items) {
              if (item.error) errorDescs.push(item.error.slice(0, 80));
            }
          }
        }
        const uniqueErrors = [...new Set(errorDescs)].slice(0, 3);
        const errorSummary = uniqueErrors.length > 0
          ? " — " + uniqueErrors.join("; ")
          : "";
        parts.push(`${signal.detail}${errorSummary}`);
        break;
      }
      case "file_churn": {
        parts.push(signal.detail);
        break;
      }
      case "repeated_tool": {
        parts.push(signal.detail);
        break;
      }
      case "stuck": {
        parts.push(signal.detail);
        break;
      }
    }
  }

  return "Spinning: " + (parts.length > 0 ? parts.join("; ") : "agent appears stuck");
}

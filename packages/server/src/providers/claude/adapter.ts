import { listProjects, listSessions, getActiveSessions } from "../../discovery/sessions.js";
import { parseSessionFile } from "../../parser/jsonl.js";
import { getCachedOrParse } from "../../core/session-cache.js";
import { isSessionStopped } from "../../core/blocked.js";
import type { SessionEvent } from "../../types/index.js";
import type {
  AgentProviderAdapter,
  BusyIdleContext,
  DiscoveryOpts,
  ParsedProviderSession,
  ProviderSessionRef,
  SessionLifecycle,
} from "../types.js";
import { toProviderSessionRef } from "../types.js";

const CLAUDE_IDLE_THRESHOLD_MS = 120_000;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function claudeDirFromOpts(opts?: DiscoveryOpts): string | undefined {
  return opts?.claudeDir ?? opts?.providerDir;
}

function normalizeClaudeEvent(
  sessionId: string,
  event: SessionEvent,
) {
  return {
    provider: "claude" as const,
    sessionId,
    eventType: event.message.role,
    line: event.line,
    timestamp: event.timestamp ?? null,
    payload: event,
  };
}

export const claudeAdapter: AgentProviderAdapter = {
  provider: "claude",

  async discoverSessions(opts?: DiscoveryOpts): Promise<ProviderSessionRef[]> {
    const claudeDir = claudeDirFromOpts(opts);
    if (opts?.projectIdentifier) {
      return listSessions(opts.projectIdentifier, claudeDir)
        .map((session) => toProviderSessionRef("claude", session));
    }

    const sessions: ProviderSessionRef[] = [];
    for (const project of listProjects(claudeDir)) {
      for (const session of listSessions(project.encodedName, claudeDir)) {
        sessions.push(toProviderSessionRef("claude", session));
      }
    }
    return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  },

  async getActiveSessions(): Promise<ProviderSessionRef[]> {
    return getActiveSessions().map((session) => toProviderSessionRef("claude", session));
  },

  async parseSession(ref: ProviderSessionRef): Promise<ParsedProviderSession> {
    const parsed = getCachedOrParse(ref);
    const rawEvents = parseSessionFile(ref.sourcePath).map((event) =>
      normalizeClaudeEvent(ref.id, event)
    );

    return {
      parsed,
      rawEvents,
      providerMetadata: {},
    };
  },

  inferSessionStatus(
    ref: ProviderSessionRef,
    parsed,
    isActive: boolean,
  ): SessionLifecycle {
    if (isActive) {
      const status = this.resolveBusyIdle(parsed, true, {});
      return { status: status === "busy" ? "active" : "idle", endedAt: null, endReason: null };
    }

    const nowMs = Date.now();
    if (nowMs - ref.sourceMtime.getTime() > STALE_THRESHOLD_MS) {
      return { status: "stale", endedAt: null, endReason: "stale" };
    }

    return { status: "idle", endedAt: null, endReason: null };
  },

  resolveBusyIdle(parsed, isActive: boolean, context: BusyIdleContext): "busy" | "idle" {
    if (!isActive) return "idle";

    const lastTurn = parsed.turns[parsed.turns.length - 1];
    if (lastTurn?.category === "interruption") return "idle";

    const mtimeMs = parsed.session.modifiedAt.getTime();
    if (isSessionStopped(parsed.session.id, mtimeMs)) return "idle";

    const nowMs = context.nowMs ?? Date.now();
    return nowMs - mtimeMs > CLAUDE_IDLE_THRESHOLD_MS ? "idle" : "busy";
  },
};

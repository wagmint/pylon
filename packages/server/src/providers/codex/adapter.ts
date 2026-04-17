import { discoverCodexSessions, getActiveCodexSessions } from "../../discovery/codex.js";
import { parseCodexSessionFile, type CodexEvent } from "../../parser/codex.js";
import { resolveCodexBusyIdle } from "../../core/codex-status.js";
import { getCachedOrParseCodex } from "../../core/session-cache.js";
import type {
  AgentProviderAdapter,
  BusyIdleContext,
  DiscoveryOpts,
  ParsedProviderSession,
  ProviderSessionRef,
  SessionLifecycle,
} from "../types.js";
import { toProviderSessionRef } from "../types.js";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function codexDirFromOpts(opts?: DiscoveryOpts): string | undefined {
  return opts?.codexDir ?? opts?.providerDir;
}

function normalizeCodexEvent(sessionId: string, event: CodexEvent) {
  return {
    provider: "codex" as const,
    sessionId,
    eventType: event.type,
    line: event.line,
    timestamp: event.timestamp,
    payload: event,
  };
}

export const codexAdapter: AgentProviderAdapter = {
  provider: "codex",

  async discoverSessions(opts?: DiscoveryOpts): Promise<ProviderSessionRef[]> {
    return discoverCodexSessions(opts?.recencyDays, codexDirFromOpts(opts))
      .map((session) => toProviderSessionRef("codex", session));
  },

  async getActiveSessions(): Promise<ProviderSessionRef[]> {
    return getActiveCodexSessions().map((session) => toProviderSessionRef("codex", session));
  },

  async parseSession(ref: ProviderSessionRef): Promise<ParsedProviderSession> {
    const parsed = getCachedOrParseCodex(ref);
    const rawCodexEvents = parseCodexSessionFile(ref.sourcePath);
    const providerMetadata: Record<string, unknown> = {};
    if (parsed.codexRuntime) {
      providerMetadata.codexRuntime = parsed.codexRuntime;
    }

    return {
      parsed,
      rawEvents: rawCodexEvents.map((event) => normalizeCodexEvent(ref.id, event)),
      providerMetadata,
    };
  },

  inferSessionStatus(
    ref: ProviderSessionRef,
    parsed,
    isActive: boolean,
  ): SessionLifecycle {
    const runtime = parsed.codexRuntime;
    if (runtime?.lastEventType === "shutdown") {
      return {
        status: "ended",
        endedAt: runtime.lastEventAt?.toISOString() ?? null,
        endReason: "explicit_shutdown",
      };
    }

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
    return resolveCodexBusyIdle({
      nowMs: context.nowMs ?? Date.now(),
      sessionMtimeMs: parsed.session.modifiedAt.getTime(),
      processAlive: isActive,
      runtime: parsed.codexRuntime,
      lastTurn: parsed.turns[parsed.turns.length - 1],
    });
  },
};

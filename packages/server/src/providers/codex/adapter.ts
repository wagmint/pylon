import { discoverCodexSessions, getActiveCodexSessions } from "./discovery.js";
import { parseCodexSessionFile, type CodexEvent } from "./parser.js";
import { getCachedOrParseCodex } from "../../core/session-cache.js";
import { inferCodexSessionStatus, resolveCodexSessionBusyIdle } from "./lifecycle.js";
import type {
  AgentProviderAdapter,
  DiscoveryOpts,
  ParsedProviderSession,
  ProviderSessionRef,
} from "../types.js";
import { toProviderSessionRef } from "../types.js";

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

  inferSessionStatus: inferCodexSessionStatus,

  resolveBusyIdle: resolveCodexSessionBusyIdle,
};

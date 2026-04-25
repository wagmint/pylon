import { listProjects, listSessions, getActiveSessions } from "./discovery.js";
import { parseSessionFile } from "./parser.js";
import { getCachedOrParse } from "../../core/session-cache.js";
import type { SessionEvent } from "../../types/index.js";
import { inferClaudeSessionStatus, resolveClaudeBusyIdle } from "./lifecycle.js";
import type {
  AgentProviderAdapter,
  DiscoveryOpts,
  ParsedProviderSession,
  ProviderSessionRef,
} from "../types.js";
import { toProviderSessionRef } from "../types.js";

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
    const { parsed, events: cachedEvents, totalLines, sourceByteLength } = getCachedOrParse(ref);
    // On cache hit, events are null (not retained in cache to save memory).
    // Re-parse from disk — cheaper than full buildParsedSession.
    const events = cachedEvents ?? parseSessionFile(ref.sourcePath);

    return {
      parsed,
      rawEvents: events.map((event) => normalizeClaudeEvent(ref.id, event)),
      claudeEvents: events,
      totalLines,
      sourceByteLength,
      providerMetadata: {},
    };
  },

  inferSessionStatus: inferClaudeSessionStatus,

  resolveBusyIdle: resolveClaudeBusyIdle,
};

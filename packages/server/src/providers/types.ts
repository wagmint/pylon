import type { ParsedSession, SessionInfo } from "../types/index.js";

export type AgentProvider = "claude" | "codex";

export interface DiscoveryOpts {
  /** Provider root directory, e.g. ~/.claude or ~/.codex. */
  providerDir?: string;
  /** Claude-specific alias for providerDir. */
  claudeDir?: string;
  /** Codex-specific alias for providerDir. */
  codexDir?: string;
  /** Codex discovery recency window. */
  recencyDays?: number;
  /** Claude project identifier, either encoded name or project path. */
  projectIdentifier?: string;
}

export interface ProviderSessionRef extends SessionInfo {
  provider: AgentProvider;
  sourcePath: string;
  sourceMtime: Date;
  sourceSizeBytes: number;
}

export interface CanonicalRawEvent {
  provider: AgentProvider;
  sessionId: string;
  eventType: string;
  line: number;
  timestamp: Date | null;
  payload: unknown;
}

export interface ParsedProviderSession {
  parsed: ParsedSession;
  rawEvents: CanonicalRawEvent[];
  providerMetadata: Record<string, unknown>;
}

export interface SessionLifecycle {
  status: "active" | "idle" | "ended" | "stale";
  endedAt: string | null;
  endReason: "process_gone" | "idle_timeout" | "explicit_shutdown" | "stale" | null;
}

export interface BusyIdleContext {
  nowMs?: number;
}

export interface AgentProviderAdapter {
  provider: AgentProvider;

  discoverSessions(opts?: DiscoveryOpts): Promise<ProviderSessionRef[]>;
  getActiveSessions(): Promise<ProviderSessionRef[]>;

  parseSession(ref: ProviderSessionRef): Promise<ParsedProviderSession>;

  inferSessionStatus(
    ref: ProviderSessionRef,
    parsed: ParsedSession,
    isActive: boolean,
  ): SessionLifecycle;

  resolveBusyIdle(
    parsed: ParsedSession,
    isActive: boolean,
    context: BusyIdleContext,
  ): "busy" | "idle";
}

export function toProviderSessionRef(
  provider: AgentProvider,
  session: SessionInfo,
): ProviderSessionRef {
  return {
    ...session,
    provider,
    sourcePath: session.path,
    sourceMtime: session.modifiedAt,
    sourceSizeBytes: session.sizeBytes,
  };
}

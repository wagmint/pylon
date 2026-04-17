import { resolveCodexBusyIdle } from "../../core/codex-status.js";
import type { ParsedSession } from "../../types/index.js";
import type { BusyIdleContext, ProviderSessionRef, SessionLifecycle } from "../types.js";

export const CODEX_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function inferCodexSessionStatus(
  ref: ProviderSessionRef,
  parsed: ParsedSession,
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
    const status = resolveCodexSessionBusyIdle(parsed, true, {});
    return { status: status === "busy" ? "active" : "idle", endedAt: null, endReason: null };
  }

  const nowMs = Date.now();
  if (nowMs - ref.sourceMtime.getTime() > CODEX_STALE_THRESHOLD_MS) {
    return { status: "stale", endedAt: null, endReason: "stale" };
  }

  return { status: "idle", endedAt: null, endReason: null };
}

export function resolveCodexSessionBusyIdle(
  parsed: ParsedSession,
  isActive: boolean,
  context: BusyIdleContext,
): "busy" | "idle" {
  if (!isActive) return "idle";
  return resolveCodexBusyIdle({
    nowMs: context.nowMs ?? Date.now(),
    sessionMtimeMs: parsed.session.modifiedAt.getTime(),
    processAlive: isActive,
    runtime: parsed.codexRuntime,
    lastTurn: parsed.turns[parsed.turns.length - 1],
  });
}

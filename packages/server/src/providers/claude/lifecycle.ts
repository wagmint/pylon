import { isSessionStopped } from "../../core/blocked.js";
import type { ParsedSession } from "../../types/index.js";
import type { BusyIdleContext, ProviderSessionRef, SessionLifecycle } from "../types.js";

export const CLAUDE_IDLE_THRESHOLD_MS = 120_000;
export const CLAUDE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function inferClaudeSessionStatus(
  ref: ProviderSessionRef,
  parsed: ParsedSession,
  isActive: boolean,
): SessionLifecycle {
  if (isActive) {
    const status = resolveClaudeBusyIdle(parsed, true, {});
    return { status: status === "busy" ? "active" : "idle", endedAt: null, endReason: null };
  }

  const nowMs = Date.now();
  if (nowMs - ref.sourceMtime.getTime() > CLAUDE_STALE_THRESHOLD_MS) {
    return { status: "stale", endedAt: null, endReason: "stale" };
  }

  return { status: "idle", endedAt: null, endReason: null };
}

export function resolveClaudeBusyIdle(
  parsed: ParsedSession,
  isActive: boolean,
  context: BusyIdleContext,
): "busy" | "idle" {
  if (!isActive) return "idle";

  const lastTurn = parsed.turns[parsed.turns.length - 1];
  if (lastTurn?.category === "interruption") return "idle";

  const mtimeMs = parsed.session.modifiedAt.getTime();
  if (isSessionStopped(parsed.session.id, mtimeMs)) return "idle";

  const nowMs = context.nowMs ?? Date.now();
  return nowMs - mtimeMs > CLAUDE_IDLE_THRESHOLD_MS ? "idle" : "busy";
}

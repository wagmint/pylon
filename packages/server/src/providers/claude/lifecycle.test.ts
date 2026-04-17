import { afterEach, describe, expect, it, vi } from "vitest";
import { markSessionStopped, stoppedSessions } from "../../core/blocked.js";
import { makeParsedSession, makeProviderSessionRef, makeTurn } from "../test-helpers.js";
import {
  CLAUDE_IDLE_THRESHOLD_MS,
  CLAUDE_STALE_THRESHOLD_MS,
  inferClaudeSessionStatus,
  resolveClaudeBusyIdle,
} from "./lifecycle.js";

afterEach(() => {
  stoppedSessions.clear();
  vi.useRealTimers();
});

describe("Claude provider lifecycle", () => {
  it("treats an active recent session as busy", () => {
    const nowMs = Date.parse("2026-04-05T12:00:10.000Z");
    const ref = makeProviderSessionRef("claude", { modifiedAt: new Date(nowMs - 1_000) });
    const parsed = makeParsedSession(ref);

    expect(resolveClaudeBusyIdle(parsed, true, { nowMs })).toBe("busy");
  });

  it("falls back to idle after the Claude mtime threshold", () => {
    const nowMs = Date.parse("2026-04-05T12:05:00.000Z");
    const ref = makeProviderSessionRef("claude", {
      modifiedAt: new Date(nowMs - CLAUDE_IDLE_THRESHOLD_MS - 1),
    });
    const parsed = makeParsedSession(ref);

    expect(resolveClaudeBusyIdle(parsed, true, { nowMs })).toBe("idle");
  });

  it("treats interrupted active turns as idle", () => {
    const nowMs = Date.parse("2026-04-05T12:00:10.000Z");
    const ref = makeProviderSessionRef("claude", { modifiedAt: new Date(nowMs) });
    const parsed = makeParsedSession(ref, {
      turns: [makeTurn({ category: "interruption" })],
    });

    expect(resolveClaudeBusyIdle(parsed, true, { nowMs })).toBe("idle");
  });

  it("honors the Claude Stop hook grace behavior", () => {
    const nowMs = Date.parse("2026-04-05T12:00:10.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const ref = makeProviderSessionRef("claude", { modifiedAt: new Date(nowMs) });
    const parsed = makeParsedSession(ref);

    markSessionStopped(ref.id);

    expect(resolveClaudeBusyIdle(parsed, true, { nowMs })).toBe("idle");
  });

  it("marks inactive old sessions stale", () => {
    const nowMs = Date.parse("2026-04-05T12:00:10.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const ref = makeProviderSessionRef("claude", {
      modifiedAt: new Date(nowMs - CLAUDE_STALE_THRESHOLD_MS - 1),
    });
    const parsed = makeParsedSession(ref);

    expect(inferClaudeSessionStatus(ref, parsed, false)).toEqual({
      status: "stale",
      endedAt: null,
      endReason: "stale",
    });
  });
});

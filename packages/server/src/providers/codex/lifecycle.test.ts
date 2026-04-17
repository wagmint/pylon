import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_SETTLE_MS } from "../../core/codex-status.js";
import { makeParsedSession, makeProviderSessionRef, makeTurn } from "../test-helpers.js";
import {
  CODEX_STALE_THRESHOLD_MS,
  inferCodexSessionStatus,
  resolveCodexSessionBusyIdle,
} from "./lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex provider lifecycle", () => {
  it("marks explicit shutdown as ended", () => {
    const shutdownAt = new Date("2026-04-05T12:00:00.000Z");
    const ref = makeProviderSessionRef("codex", { modifiedAt: shutdownAt });
    const parsed = makeParsedSession(ref, {
      codexRuntime: {
        lastEventType: "shutdown",
        lastEventAt: shutdownAt,
        inTurn: false,
        lastToolActivityAt: null,
      },
    });

    expect(inferCodexSessionStatus(ref, parsed, false)).toEqual({
      status: "ended",
      endedAt: shutdownAt.toISOString(),
      endReason: "explicit_shutdown",
    });
  });

  it("goes idle shortly after turn_complete", () => {
    const nowMs = Date.parse("2026-04-05T12:00:10.000Z");
    const lastEventAt = new Date(nowMs - CODEX_SETTLE_MS - 100);
    const ref = makeProviderSessionRef("codex", { modifiedAt: lastEventAt });
    const parsed = makeParsedSession(ref, {
      codexRuntime: {
        lastEventType: "turn_complete",
        lastEventAt,
        inTurn: false,
        lastToolActivityAt: null,
      },
      turns: [makeTurn({ timestamp: new Date(nowMs - 20_000), durationMs: 1_000 })],
    });

    expect(resolveCodexSessionBusyIdle(parsed, true, { nowMs })).toBe("idle");
  });

  it("marks inactive old sessions stale", () => {
    const nowMs = Date.parse("2026-04-05T12:00:10.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const ref = makeProviderSessionRef("codex", {
      modifiedAt: new Date(nowMs - CODEX_STALE_THRESHOLD_MS - 1),
    });
    const parsed = makeParsedSession(ref);

    expect(inferCodexSessionStatus(ref, parsed, false)).toEqual({
      status: "stale",
      endedAt: null,
      endReason: "stale",
    });
  });
});

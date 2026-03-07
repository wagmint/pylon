import { describe, it, expect } from "vitest";
import {
  resolveCodexBusyIdle,
  CODEX_BUSY_WINDOW_MS,
  CODEX_SETTLE_MS,
  CODEX_PROCESS_GRACE_MS,
  CODEX_IN_TURN_PROCESS_GRACE_MS,
} from "./codex-status.js";
import type { TurnNode } from "../types/index.js";

function makeTurn(ts: number, durationMs: number | null): TurnNode {
  return {
    id: "turn-0",
    index: 0,
    timestamp: new Date(ts),
    summary: "x",
    category: "task",
    userInstruction: "x",
    assistantPreview: "x",
    sections: {
      goal: { summary: "", fullInstruction: "" },
      approach: { summary: "", thinking: "" },
      decisions: { summary: "", items: [] },
      research: { summary: "", filesRead: [], searches: [] },
      actions: { summary: "", edits: [], commands: [], creates: [] },
      corrections: { summary: "", items: [] },
      artifacts: { summary: "", filesChanged: [], commits: [] },
      escalations: { summary: "", questions: [] },
    },
    toolCalls: [],
    toolCounts: {},
    filesChanged: [],
    filesRead: [],
    hasCommit: false,
    hasPush: false,
    hasPull: false,
    commitMessage: null,
    commitSha: null,
    commands: [],
    hasError: false,
    errorCount: 0,
    hasCompaction: false,
    compactionText: null,
    hasPlanStart: false,
    hasPlanEnd: false,
    planMarkdown: null,
    planRejected: false,
    taskCreates: [],
    taskUpdates: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    model: "codex",
    contextWindowTokens: null,
    durationMs,
    events: [],
    startLine: 0,
    endLine: 0,
  };
}

describe("resolveCodexBusyIdle", () => {
  const base = Date.parse("2026-03-05T12:00:00.000Z");

  it("stays busy while in-turn with recent activity", () => {
    const status = resolveCodexBusyIdle({
      nowMs: base + 2_000,
      sessionMtimeMs: base,
      processAlive: true,
      runtime: {
        inTurn: true,
        lastEventType: "turn_started",
        lastEventAt: new Date(base),
        lastToolActivityAt: new Date(base + 1_000),
      },
      lastTurn: makeTurn(base, null),
    });
    expect(status).toBe("busy");
  });

  it("goes idle when in-turn but stale with no progress", () => {
    const status = resolveCodexBusyIdle({
      nowMs: base + CODEX_BUSY_WINDOW_MS + 1_000,
      sessionMtimeMs: base,
      processAlive: false,
      runtime: {
        inTurn: true,
        lastEventType: "turn_started",
        lastEventAt: new Date(base),
        lastToolActivityAt: null,
      },
      lastTurn: makeTurn(base, null),
    });
    expect(status).toBe("idle");
  });

  it("goes idle shortly after turn_complete", () => {
    const status = resolveCodexBusyIdle({
      nowMs: base + CODEX_SETTLE_MS + 100,
      sessionMtimeMs: base,
      processAlive: true,
      runtime: {
        inTurn: false,
        lastEventType: "turn_complete",
        lastEventAt: new Date(base),
        lastToolActivityAt: null,
      },
      lastTurn: makeTurn(base - 5_000, 4_000),
    });
    expect(status).toBe("idle");
  });

  it("stays busy briefly after recent tool activity", () => {
    const status = resolveCodexBusyIdle({
      nowMs: base + 1_000,
      sessionMtimeMs: base,
      processAlive: true,
      runtime: {
        inTurn: false,
        lastEventType: null,
        lastEventAt: new Date(base),
        lastToolActivityAt: new Date(base),
      },
      lastTurn: makeTurn(base - 10_000, 3_000),
    });
    expect(status).toBe("busy");
  });

  it("goes idle when process is alive but no event progress past grace", () => {
    const status = resolveCodexBusyIdle({
      nowMs: base + CODEX_PROCESS_GRACE_MS + 100,
      sessionMtimeMs: base,
      processAlive: true,
      runtime: {
        inTurn: false,
        lastEventType: null,
        lastEventAt: new Date(base),
        lastToolActivityAt: null,
      },
      lastTurn: makeTurn(base - 20_000, 2_000),
    });
    expect(status).toBe("idle");
  });

  it("stays busy during a quiet live turn while the Codex process is still alive", () => {
    const status = resolveCodexBusyIdle({
      nowMs: base + CODEX_BUSY_WINDOW_MS + 30_000,
      sessionMtimeMs: base,
      processAlive: true,
      runtime: {
        inTurn: true,
        lastEventType: "turn_started",
        lastEventAt: new Date(base),
        lastToolActivityAt: null,
      },
      lastTurn: makeTurn(base, null),
    });
    expect(status).toBe("busy");
  });

  it("goes idle if a quiet in-turn session exceeds the long live-process grace", () => {
    const status = resolveCodexBusyIdle({
      nowMs: base + CODEX_IN_TURN_PROCESS_GRACE_MS + 100,
      sessionMtimeMs: base,
      processAlive: true,
      runtime: {
        inTurn: true,
        lastEventType: "turn_started",
        lastEventAt: new Date(base),
        lastToolActivityAt: null,
      },
      lastTurn: makeTurn(base, null),
    });
    expect(status).toBe("idle");
  });
});

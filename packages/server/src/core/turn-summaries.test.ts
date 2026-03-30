import { describe, it, expect, vi, afterEach } from "vitest";
import { buildTurnSummaries } from "./turn-summaries.js";
import type { TurnNode, TokenUsage } from "../types/index.js";

const NOW = Date.parse("2026-03-29T12:00:00.000Z");

function makeTurn(overrides: Partial<TurnNode> & { id: string; timestamp: Date }): TurnNode {
  const zeroTokens: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  return {
    index: 0,
    summary: "",
    category: "task",
    userInstruction: "do something",
    assistantPreview: "did something",
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
    tokenUsage: zeroTokens,
    model: null,
    contextWindowTokens: null,
    durationMs: null,
    events: [],
    startLine: 0,
    endLine: 0,
    ...overrides,
  };
}

describe("buildTurnSummaries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function useFakeNow() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  }

  it("returns empty summaries for empty turns", () => {
    useFakeNow();
    const result = buildTurnSummaries([]);
    expect(result.summaries).toEqual([]);
    expect(result.skippedTurnCount).toBe(0);
  });

  it("returns empty summaries when all turns are older than 7 days", () => {
    useFakeNow();
    const oldDate = new Date(NOW - 8 * 24 * 60 * 60 * 1000);
    const turns = [makeTurn({ id: "t1", timestamp: oldDate })];
    const result = buildTurnSummaries(turns);
    expect(result.summaries).toEqual([]);
  });

  it("returns user + assistant pair for one recent turn", () => {
    useFakeNow();
    const turns = [
      makeTurn({ id: "t1", timestamp: new Date(NOW - 60_000), userInstruction: "hello", assistantPreview: "world" }),
    ];
    const result = buildTurnSummaries(turns);
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0].role).toBe("user");
    expect(result.summaries[0].userInstruction).toBe("hello");
    expect(result.summaries[1].role).toBe("assistant");
    expect(result.summaries[1].assistantPreview).toBe("world");
  });

  it("returns at most 3 recent turns + 1 init prompt", () => {
    useFakeNow();
    const turns = Array.from({ length: 6 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        timestamp: new Date(NOW - (6 - i) * 60_000),
        userInstruction: `instruction ${i}`,
        assistantPreview: `response ${i}`,
      }),
    );
    const result = buildTurnSummaries(turns);
    // 3 recent + 1 init = 4 turns, each with user + assistant = 8 summaries
    const userSummaries = result.summaries.filter((s) => s.role === "user");
    expect(userSummaries.length).toBe(4);
  });

  it("does not duplicate init turn if it is within the 3 most recent", () => {
    useFakeNow();
    const turns = [
      makeTurn({ id: "t0", timestamp: new Date(NOW - 3 * 60_000) }),
      makeTurn({ id: "t1", timestamp: new Date(NOW - 2 * 60_000) }),
    ];
    const result = buildTurnSummaries(turns);
    const userSummaries = result.summaries.filter((s) => s.role === "user");
    // 2 turns total, init is within latest 3 so no duplication
    expect(userSummaries.length).toBe(2);
  });

  it("computes skippedTurnCount correctly", () => {
    useFakeNow();
    const turns = Array.from({ length: 8 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        timestamp: new Date(NOW - (8 - i) * 60_000),
      }),
    );
    const result = buildTurnSummaries(turns);
    // 8 recent turns, show 3 latest + 1 init = 4 selected, 8 - 4 = 4 skipped
    expect(result.skippedTurnCount).toBe(4);
  });

  it("omits assistant summary when turn has no preview, actions, files, commits, or errors", () => {
    useFakeNow();
    const turns = [
      makeTurn({
        id: "t1",
        timestamp: new Date(NOW - 60_000),
        userInstruction: "hello",
        assistantPreview: "",
        filesChanged: [],
        hasCommit: false,
        hasError: false,
      }),
    ];
    const result = buildTurnSummaries(turns);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].role).toBe("user");
  });

  it("includes error flag in assistant summary", () => {
    useFakeNow();
    const turns = [
      makeTurn({
        id: "t1",
        timestamp: new Date(NOW - 60_000),
        hasError: true,
        assistantPreview: "",
      }),
    ];
    const result = buildTurnSummaries(turns);
    const assistant = result.summaries.find((s) => s.role === "assistant");
    expect(assistant?.hasError).toBe(true);
  });

  it("includes commit message in assistant summary", () => {
    useFakeNow();
    const turns = [
      makeTurn({
        id: "t1",
        timestamp: new Date(NOW - 60_000),
        hasCommit: true,
        commitMessage: "fix: resolve bug",
        assistantPreview: "",
      }),
    ];
    const result = buildTurnSummaries(turns);
    const assistant = result.summaries.find((s) => s.role === "assistant");
    expect(assistant?.hasCommit).toBe(true);
    expect(assistant?.commitMessage).toBe("fix: resolve bug");
  });

  it("includes token usage as { input, output } in assistant summary", () => {
    useFakeNow();
    const turns = [
      makeTurn({
        id: "t1",
        timestamp: new Date(NOW - 60_000),
        assistantPreview: "response",
        tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    ];
    const result = buildTurnSummaries(turns);
    const assistant = result.summaries.find((s) => s.role === "assistant");
    expect(assistant?.tokenUsage).toEqual({ input: 100, output: 50 });
  });

  it("sorts by newest first", () => {
    useFakeNow();
    const turns = [
      makeTurn({ id: "t0", timestamp: new Date(NOW - 3 * 60_000), userInstruction: "first" }),
      makeTurn({ id: "t1", timestamp: new Date(NOW - 2 * 60_000), userInstruction: "second" }),
      makeTurn({ id: "t2", timestamp: new Date(NOW - 1 * 60_000), userInstruction: "third" }),
    ];
    const result = buildTurnSummaries(turns);
    const userSummaries = result.summaries.filter((s) => s.role === "user");
    // newest first, init pinned at bottom
    expect(userSummaries[0].userInstruction).toBe("third");
    expect(userSummaries[1].userInstruction).toBe("second");
    expect(userSummaries[2].userInstruction).toBe("first"); // init pinned at bottom
  });
});

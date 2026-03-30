import { describe, it, expect } from "vitest";
import {
  getMessageText,
  getToolCalls,
  getToolResults,
  hasCompaction,
  getCompactionText,
  getThinkingText,
  getSearchPatterns,
  getSessionStats,
} from "./jsonl.js";
import type { Message, SessionEvent } from "../types/index.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function msg(role: "user" | "assistant", content: Message["content"]): Message {
  return { role, content };
}

function evt(message: Message): SessionEvent {
  return { line: 0, message };
}

// ─── getMessageText ────────────────────────────────────────────────────────

describe("getMessageText", () => {
  it("returns string content directly", () => {
    expect(getMessageText(msg("user", "hello"))).toBe("hello");
  });

  it("concatenates text blocks with newlines", () => {
    const m = msg("assistant", [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ]);
    expect(getMessageText(m)).toBe("line one\nline two");
  });

  it("ignores non-text blocks", () => {
    const m = msg("assistant", [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "hmm" },
    ]);
    expect(getMessageText(m)).toBe("hello");
  });

  it("returns empty string for empty content array", () => {
    expect(getMessageText(msg("assistant", []))).toBe("");
  });
});

// ─── getToolCalls ──────────────────────────────────────────────────────────

describe("getToolCalls", () => {
  it("returns empty for string content", () => {
    expect(getToolCalls(msg("user", "text"))).toEqual([]);
  });

  it("extracts tool_use blocks", () => {
    const m = msg("assistant", [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
    ]);
    const calls = getToolCalls(m);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("Read");
  });

  it("ignores non-tool_use blocks", () => {
    const m = msg("assistant", [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]);
    expect(getToolCalls(m)).toHaveLength(1);
  });
});

// ─── getToolResults ────────────────────────────────────────────────────────

describe("getToolResults", () => {
  it("returns empty for string content", () => {
    expect(getToolResults(msg("user", "text"))).toEqual([]);
  });

  it("extracts tool_result blocks with string content", () => {
    const m = msg("user", [
      { type: "tool_result", tool_use_id: "t1", content: "output" } as any,
    ]);
    const results = getToolResults(m);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("output");
    expect(results[0].tool_use_id).toBe("t1");
  });

  it("preserves is_error flag when present", () => {
    const m = msg("user", [
      { type: "tool_result", tool_use_id: "t1", content: "error msg", is_error: true } as any,
    ]);
    const results = getToolResults(m);
    expect(results[0].is_error).toBe(true);
  });

  it("normalizes array content to concatenated string", () => {
    const m = msg("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
      } as any,
    ]);
    const results = getToolResults(m);
    expect(results[0].content).toBe("line1\nline2");
  });
});

// ─── hasCompaction ─────────────────────────────────────────────────────────

describe("hasCompaction", () => {
  it("returns false for string content", () => {
    expect(hasCompaction(msg("user", "text"))).toBe(false);
  });

  it("returns true when compaction block exists", () => {
    const m = msg("user", [{ type: "compaction", content: "summary" }]);
    expect(hasCompaction(m)).toBe(true);
  });

  it("returns false when no compaction block", () => {
    const m = msg("assistant", [{ type: "text", text: "hello" }]);
    expect(hasCompaction(m)).toBe(false);
  });
});

// ─── getCompactionText ─────────────────────────────────────────────────────

describe("getCompactionText", () => {
  it("returns null for string content", () => {
    expect(getCompactionText(msg("user", "text"))).toBeNull();
  });

  it("returns compaction content text", () => {
    const m = msg("user", [{ type: "compaction", content: "compacted summary" }]);
    expect(getCompactionText(m)).toBe("compacted summary");
  });

  it("returns null when no compaction block", () => {
    const m = msg("assistant", [{ type: "text", text: "hello" }]);
    expect(getCompactionText(m)).toBeNull();
  });
});

// ─── getThinkingText ───────────────────────────────────────────────────────

describe("getThinkingText", () => {
  it("returns empty string for string content", () => {
    expect(getThinkingText(msg("user", "text"))).toBe("");
  });

  it("concatenates thinking blocks", () => {
    const m = msg("assistant", [
      { type: "thinking", thinking: "first thought" },
      { type: "thinking", thinking: "second thought" },
    ]);
    expect(getThinkingText(m)).toBe("first thought\nsecond thought");
  });

  it("returns empty string when no thinking blocks", () => {
    const m = msg("assistant", [{ type: "text", text: "hello" }]);
    expect(getThinkingText(m)).toBe("");
  });
});

// ─── getSearchPatterns ─────────────────────────────────────────────────────

describe("getSearchPatterns", () => {
  it("returns empty for string content", () => {
    expect(getSearchPatterns(msg("user", "text"))).toEqual([]);
  });

  it("extracts Grep patterns", () => {
    const m = msg("assistant", [
      { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "function\\s+\\w+" } },
    ]);
    expect(getSearchPatterns(m)).toEqual(["function\\s+\\w+"]);
  });

  it("extracts Glob patterns", () => {
    const m = msg("assistant", [
      { type: "tool_use", id: "t1", name: "Glob", input: { pattern: "**/*.ts" } },
    ]);
    expect(getSearchPatterns(m)).toEqual(["**/*.ts"]);
  });

  it("ignores other tool types", () => {
    const m = msg("assistant", [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
      { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "test" } },
    ]);
    expect(getSearchPatterns(m)).toEqual(["test"]);
  });
});

// ─── getSessionStats ───────────────────────────────────────────────────────

describe("getSessionStats", () => {
  it("returns zeros for empty events", () => {
    const stats = getSessionStats([]);
    expect(stats.totalEvents).toBe(0);
    expect(stats.userMessages).toBe(0);
    expect(stats.assistantMessages).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.compactions).toBe(0);
  });

  it("counts user and assistant messages", () => {
    const events = [
      evt(msg("user", "hello")),
      evt(msg("assistant", [{ type: "text", text: "hi" }])),
      evt(msg("user", "bye")),
    ];
    const stats = getSessionStats(events);
    expect(stats.userMessages).toBe(2);
    expect(stats.assistantMessages).toBe(1);
  });

  it("counts total tool calls", () => {
    const events = [
      evt(msg("assistant", [
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "tool_use", id: "t2", name: "Edit", input: {} },
      ])),
    ];
    expect(getSessionStats(events).toolCalls).toBe(2);
  });

  it("builds toolsUsed map", () => {
    const events = [
      evt(msg("assistant", [
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
        { type: "tool_use", id: "t3", name: "Edit", input: {} },
      ])),
    ];
    const stats = getSessionStats(events);
    expect(stats.toolsUsed).toEqual({ Read: 2, Edit: 1 });
  });

  it("counts compactions", () => {
    const events = [
      evt(msg("user", [{ type: "compaction", content: "summary" }])),
      evt(msg("assistant", [{ type: "text", text: "ok" }])),
    ];
    expect(getSessionStats(events).compactions).toBe(1);
  });
});

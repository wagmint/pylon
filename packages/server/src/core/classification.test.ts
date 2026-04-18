import { describe, expect, it } from "vitest";
import { classifySessionOutcome, type ClassificationInput } from "./classification.js";

function input(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    totalTurns: 0,
    totalCommits: 0,
    hadSpinning: false,
    errorRate: 0,
    hasPush: false,
    toolsUsed: {},
    ...overrides,
  };
}

describe("classifySessionOutcome", () => {
  it("productive: session with commits", () => {
    const result = classifySessionOutcome(input({ totalTurns: 5, totalCommits: 2 }));
    expect(result).toEqual({ outcome: "productive", isDeadEnd: false, deadEndReason: null });
  });

  it("productive: session with push only (no commits)", () => {
    const result = classifySessionOutcome(input({ totalTurns: 5, hasPush: true }));
    expect(result).toEqual({ outcome: "productive", isDeadEnd: false, deadEndReason: null });
  });

  it("productive: session with both commits and push", () => {
    const result = classifySessionOutcome(input({ totalTurns: 5, totalCommits: 1, hasPush: true }));
    expect(result).toEqual({ outcome: "productive", isDeadEnd: false, deadEndReason: null });
  });

  it("research: read-heavy, no commits, low error rate", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 8,
      errorRate: 0.1,
      toolsUsed: { Read: 10, Grep: 5, Glob: 3, Bash: 2 },
    }));
    expect(result).toEqual({ outcome: "research", isDeadEnd: false, deadEndReason: null });
  });

  it("dead_end:spinning — had spinning, 0 commits, 3+ turns", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 5,
      hadSpinning: true,
      errorRate: 0.8,
      toolsUsed: { Bash: 5, Edit: 3 },
    }));
    expect(result).toEqual({ outcome: "dead_end:spinning", isDeadEnd: true, deadEndReason: "dead_end:spinning" });
  });

  it("dead_end:abandoned — 10+ turns, 0 commits, not research, not spinning", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 12,
      errorRate: 0.4,
      toolsUsed: { Bash: 5, Edit: 3, Read: 2 },
    }));
    expect(result).toEqual({ outcome: "dead_end:abandoned", isDeadEnd: true, deadEndReason: "dead_end:abandoned" });
  });

  it("abandoned_start: < 3 turns, 0 commits", () => {
    const result = classifySessionOutcome(input({ totalTurns: 2 }));
    expect(result).toEqual({ outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null });
  });

  it("abandoned_start: 0 turns", () => {
    const result = classifySessionOutcome(input({ totalTurns: 0 }));
    expect(result).toEqual({ outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null });
  });

  it("edge: 0 tool calls → not research (empty toolsUsed)", () => {
    const result = classifySessionOutcome(input({ totalTurns: 5, errorRate: 0.1 }));
    // No tool calls → can't be research (majority check fails), not spinning, < 10 turns
    expect(result).toEqual({ outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null });
  });

  it("fallback: 5 turns, 0 commits, no spinning, not research → abandoned_start", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 5,
      errorRate: 0.1,
      toolsUsed: { Bash: 5, Edit: 3 },
    }));
    expect(result).toEqual({ outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null });
  });

  it("abandoned_start wins over research when < 3 turns", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 2,
      toolsUsed: { Read: 10 },
      errorRate: 0,
    }));
    expect(result).toEqual({ outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null });
  });

  it("productive wins over spinning when commits exist", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 10,
      totalCommits: 1,
      hadSpinning: true,
      errorRate: 0.5,
    }));
    expect(result).toEqual({ outcome: "productive", isDeadEnd: false, deadEndReason: null });
  });

  it("research: exactly at boundary — errorRate 0.29, majority read-only", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 3,
      errorRate: 0.29,
      toolsUsed: { Read: 3, Bash: 2 },
    }));
    expect(result).toEqual({ outcome: "research", isDeadEnd: false, deadEndReason: null });
  });

  it("not research when errorRate >= 0.3", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 5,
      errorRate: 0.3,
      toolsUsed: { Read: 10, Grep: 5 },
    }));
    // errorRate not < 0.3, so not research; not spinning; < 10 turns → fallback
    expect(result).toEqual({ outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null });
  });

  it("not research when read-only calls are exactly half (not majority)", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 5,
      errorRate: 0,
      toolsUsed: { Read: 5, Bash: 5 },
    }));
    // readOnly (5) is not > total/2 (5), so not majority → fallback
    expect(result).toEqual({ outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null });
  });

  it("WebSearch and WebFetch count as read-only", () => {
    const result = classifySessionOutcome(input({
      totalTurns: 4,
      errorRate: 0,
      toolsUsed: { WebSearch: 3, WebFetch: 2, Edit: 1 },
    }));
    // 5 read-only out of 6 total → research
    expect(result).toEqual({ outcome: "research", isDeadEnd: false, deadEndReason: null });
  });
});

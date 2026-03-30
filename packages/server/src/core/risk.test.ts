import { describe, it, expect } from "vitest";
import { detectSpinning, computeAgentRisk, computeWorkstreamRisk } from "./risk.js";
import type { TurnNode, TokenUsage, ParsedSession, SessionInfo } from "../types/index.js";
import type { Agent, AgentRisk } from "../types/index.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ZERO_TOKENS: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const BASE = Date.parse("2026-03-29T12:00:00.000Z");

function makeTurn(overrides?: Partial<TurnNode>): TurnNode {
  return {
    id: "t0",
    index: 0,
    timestamp: new Date(BASE),
    summary: "",
    category: "task",
    userInstruction: "",
    assistantPreview: "",
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
    tokenUsage: ZERO_TOKENS,
    model: null,
    contextWindowTokens: null,
    durationMs: null,
    events: [],
    startLine: 0,
    endLine: 0,
    ...overrides,
  };
}

function makeSession(turns: TurnNode[]): SessionInfo {
  return {
    id: "session-1",
    path: "/home/user/.claude/projects/test/session.jsonl",
    projectPath: "/home/user/project",
    createdAt: new Date(BASE),
    modifiedAt: new Date(BASE),
    sizeBytes: 1000,
  };
}

function makeParsedSession(turns: TurnNode[], overrides?: Partial<ParsedSession["stats"]>): ParsedSession {
  const errorTurns = turns.filter((t) => t.hasError).length;
  const correctionTurns = turns.filter(
    (t) => t.sections.corrections.items.length > 0,
  ).length;
  const totalTokenUsage = turns.reduce(
    (acc, t) => ({
      inputTokens: acc.inputTokens + t.tokenUsage.inputTokens,
      outputTokens: acc.outputTokens + t.tokenUsage.outputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens + t.tokenUsage.cacheReadInputTokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens + t.tokenUsage.cacheCreationInputTokens,
    }),
    { ...ZERO_TOKENS },
  );
  const commits = turns.filter((t) => t.hasCommit).length;
  const allFiles = [...new Set(turns.flatMap((t) => t.filesChanged))];
  const toolCalls = turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
  const compactions = turns.filter((t) => t.hasCompaction).length;

  return {
    session: makeSession(turns),
    turns,
    stats: {
      totalEvents: turns.length * 2,
      totalTurns: turns.length,
      toolCalls,
      commits,
      compactions,
      filesChanged: allFiles,
      toolsUsed: {},
      totalTokenUsage,
      errorTurns,
      correctionTurns,
      primaryModel: null,
      ...overrides,
    },
  };
}

function makeRisk(overrides?: Partial<AgentRisk>): AgentRisk {
  return {
    errorRate: 0,
    correctionRatio: 1,
    totalTokens: 0,
    compactions: 0,
    compactionProximity: "nominal",
    fileHotspots: [],
    spinningSignals: [],
    overallRisk: "nominal",
    errorTrend: [],
    modelBreakdown: [],
    sourceBreakdown: [],
    contextUsagePct: 0,
    contextTokens: 0,
    avgTurnTimeMs: null,
    sessionDurationMs: 0,
    costEstimate: 0,
    ...overrides,
  };
}

// ─── detectSpinning ────────────────────────────────────────────────────────

describe("detectSpinning", () => {
  describe("error_loop pattern", () => {
    it("returns no signal with 0 errors", () => {
      const turns = Array.from({ length: 5 }, () => makeTurn());
      expect(detectSpinning(turns).filter((s) => s.pattern === "error_loop")).toEqual([]);
    });

    it("returns no signal with 2 consecutive errors", () => {
      const turns = [
        makeTurn(),
        makeTurn({ hasError: true }),
        makeTurn({ hasError: true }),
      ];
      expect(detectSpinning(turns).filter((s) => s.pattern === "error_loop")).toEqual([]);
    });

    it("returns elevated signal with 3 consecutive errors", () => {
      const turns = [
        makeTurn(),
        makeTurn({ hasError: true }),
        makeTurn({ hasError: true }),
        makeTurn({ hasError: true }),
      ];
      const signals = detectSpinning(turns).filter((s) => s.pattern === "error_loop");
      expect(signals).toHaveLength(1);
      expect(signals[0].level).toBe("elevated");
    });

    it("returns critical signal with 5 consecutive errors", () => {
      const turns = Array.from({ length: 5 }, () => makeTurn({ hasError: true }));
      const signals = detectSpinning(turns).filter((s) => s.pattern === "error_loop");
      expect(signals).toHaveLength(1);
      expect(signals[0].level).toBe("critical");
    });

    it("resets count when a non-error turn breaks the streak", () => {
      const turns = [
        makeTurn({ hasError: true }),
        makeTurn({ hasError: true }),
        makeTurn({ hasError: true }),
        makeTurn(), // breaks streak
        makeTurn({ hasError: true }),
        makeTurn({ hasError: true }),
      ];
      const signals = detectSpinning(turns).filter((s) => s.pattern === "error_loop");
      expect(signals).toEqual([]); // only 2 consecutive at end
    });
  });

  describe("file_churn pattern", () => {
    it("returns no signal when file edited < 5 times", () => {
      const turns = Array.from({ length: 4 }, () =>
        makeTurn({ filesChanged: ["src/app.ts"] }),
      );
      expect(detectSpinning(turns).filter((s) => s.pattern === "file_churn")).toEqual([]);
    });

    it("returns elevated signal when file edited 5 times in last 10 turns", () => {
      const turns = Array.from({ length: 5 }, () =>
        makeTurn({ filesChanged: ["src/app.ts"] }),
      );
      const signals = detectSpinning(turns).filter((s) => s.pattern === "file_churn");
      expect(signals).toHaveLength(1);
      expect(signals[0].level).toBe("elevated");
    });

    it("returns critical signal when file edited 8+ times", () => {
      const turns = Array.from({ length: 8 }, () =>
        makeTurn({ filesChanged: ["src/app.ts"] }),
      );
      const signals = detectSpinning(turns).filter((s) => s.pattern === "file_churn");
      expect(signals).toHaveLength(1);
      expect(signals[0].level).toBe("critical");
    });
  });

  describe("repeated_tool pattern", () => {
    it("returns no signal for < 4 repeated tool+target in last 5 turns", () => {
      const turns = Array.from({ length: 3 }, () =>
        makeTurn({
          toolCalls: [{ name: "Bash", input: { command: "npm test" } }],
        }),
      );
      expect(detectSpinning(turns).filter((s) => s.pattern === "repeated_tool")).toEqual([]);
    });

    it("returns elevated signal for 4+ repeated Bash commands", () => {
      const turns = Array.from({ length: 4 }, () =>
        makeTurn({
          toolCalls: [{ name: "Bash", input: { command: "npm test" } }],
        }),
      );
      const signals = detectSpinning(turns).filter((s) => s.pattern === "repeated_tool");
      expect(signals).toHaveLength(1);
      expect(signals[0].level).toBe("elevated");
    });

    it("excludes Read, Edit, Write from spinning detection", () => {
      const turns = Array.from({ length: 5 }, () =>
        makeTurn({
          toolCalls: [{ name: "Edit", input: { file_path: "src/app.ts" } }],
        }),
      );
      expect(detectSpinning(turns).filter((s) => s.pattern === "repeated_tool")).toEqual([]);
    });
  });

  describe("stuck pattern", () => {
    it("returns no signal when errors < 5", () => {
      const turns = Array.from({ length: 4 }, () => makeTurn({ hasError: true }));
      expect(detectSpinning(turns).filter((s) => s.pattern === "stuck")).toEqual([]);
    });

    it("returns no signal when there are commits", () => {
      const turns = [
        ...Array.from({ length: 5 }, () => makeTurn({ hasError: true })),
        makeTurn({ hasCommit: true }),
      ];
      expect(detectSpinning(turns).filter((s) => s.pattern === "stuck")).toEqual([]);
    });

    it("returns critical signal with 5+ errors and 0 commits", () => {
      const turns = Array.from({ length: 5 }, () => makeTurn({ hasError: true }));
      const signals = detectSpinning(turns).filter((s) => s.pattern === "stuck");
      expect(signals).toHaveLength(1);
      expect(signals[0].level).toBe("critical");
    });
  });
});

// ─── computeAgentRisk ──────────────────────────────────────────────────────

describe("computeAgentRisk", () => {
  it("returns nominal risk for a clean session with no errors", () => {
    const turns = Array.from({ length: 6 }, (_, i) =>
      makeTurn({ id: `t${i}`, timestamp: new Date(BASE + i * 60_000) }),
    );
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.overallRisk).toBe("nominal");
    expect(risk.errorRate).toBe(0);
  });

  it("returns elevated risk for error rate > 20% with 6+ turns", () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        timestamp: new Date(BASE + i * 60_000),
        hasError: i < 3, // 3 out of 10 = 30%
      }),
    );
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.overallRisk).toBe("elevated");
  });

  it("returns critical risk for error rate > 35% and low correction ratio", () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        timestamp: new Date(BASE + i * 60_000),
        hasError: i < 4, // 4 out of 10 = 40%
      }),
    );
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.overallRisk).toBe("critical");
  });

  it("does not flag error rate with < 6 turns (insufficient data)", () => {
    const turns = Array.from({ length: 4 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        timestamp: new Date(BASE + i * 60_000),
        hasError: i < 2, // 2 out of 4 = 50%, but insufficient data
      }),
    );
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.overallRisk).toBe("nominal");
  });

  it("returns elevated compactionProximity when avgInputPerTurn > 100k", () => {
    const turns = Array.from({ length: 5 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        timestamp: new Date(BASE + i * 60_000),
        tokenUsage: { inputTokens: 120_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    );
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.compactionProximity).toBe("elevated");
  });

  it("returns critical compactionProximity when avgInputPerTurn > 150k", () => {
    const turns = Array.from({ length: 5 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        timestamp: new Date(BASE + i * 60_000),
        tokenUsage: { inputTokens: 160_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    );
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.compactionProximity).toBe("critical");
  });

  it("computes file hotspots for files edited 3+ times", () => {
    const turns = Array.from({ length: 4 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        timestamp: new Date(BASE + i * 60_000),
        filesChanged: ["src/hot.ts"],
      }),
    );
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.fileHotspots).toHaveLength(1);
    expect(risk.fileHotspots[0].count).toBe(4);
  });

  it("computes session duration from first to last turn", () => {
    const turns = [
      makeTurn({ id: "t0", timestamp: new Date(BASE) }),
      makeTurn({ id: "t1", timestamp: new Date(BASE + 60_000) }),
      makeTurn({ id: "t2", timestamp: new Date(BASE + 120_000) }),
    ];
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.sessionDurationMs).toBe(120_000);
  });

  it("computes model breakdown from turn models", () => {
    const turns = [
      makeTurn({ id: "t0", timestamp: new Date(BASE), model: "claude-sonnet-4", tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
      makeTurn({ id: "t1", timestamp: new Date(BASE + 60_000), model: "claude-sonnet-4", tokenUsage: { inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
    ];
    const risk = computeAgentRisk(makeParsedSession(turns));
    expect(risk.modelBreakdown).toHaveLength(1);
    expect(risk.modelBreakdown[0].model).toBe("claude-sonnet-4");
    expect(risk.modelBreakdown[0].turnCount).toBe(2);
  });
});

// ─── computeWorkstreamRisk ─────────────────────────────────────────────────

describe("computeWorkstreamRisk", () => {
  function makeAgent(riskOverrides?: Partial<AgentRisk>): Agent {
    return {
      sessionId: "s1",
      label: "agent-1",
      agentType: "claude",
      status: "busy",
      currentTask: "",
      filesChanged: [],
      uncommittedFiles: [],
      projectPath: "/project",
      isActive: true,
      plans: [],
      risk: makeRisk(riskOverrides),
      operatorId: "op-self",
      recentTurns: [],
      skippedTurnCount: 0,
    };
  }

  it("returns nominal for empty agents array", () => {
    const result = computeWorkstreamRisk([]);
    expect(result.overallRisk).toBe("nominal");
    expect(result.totalTokens).toBe(0);
  });

  it("returns critical when any agent is critical", () => {
    const agents = [
      makeAgent({ overallRisk: "nominal" }),
      makeAgent({ overallRisk: "critical" }),
    ];
    expect(computeWorkstreamRisk(agents).overallRisk).toBe("critical");
  });

  it("returns elevated when any agent is elevated but none critical", () => {
    const agents = [
      makeAgent({ overallRisk: "nominal" }),
      makeAgent({ overallRisk: "elevated" }),
    ];
    expect(computeWorkstreamRisk(agents).overallRisk).toBe("elevated");
  });

  it("computes aggregate token count across agents", () => {
    const agents = [
      makeAgent({ totalTokens: 1000 }),
      makeAgent({ totalTokens: 2000 }),
    ];
    expect(computeWorkstreamRisk(agents).totalTokens).toBe(3000);
  });

  it("counts risky agents (non-nominal)", () => {
    const agents = [
      makeAgent({ overallRisk: "nominal" }),
      makeAgent({ overallRisk: "elevated" }),
      makeAgent({ overallRisk: "critical" }),
    ];
    expect(computeWorkstreamRisk(agents).riskyAgents).toBe(2);
  });
});

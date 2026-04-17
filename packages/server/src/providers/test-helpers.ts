import type { ParsedSession, SessionInfo, TurnNode } from "../types/index.js";
import type { ProviderSessionRef, AgentProvider } from "./types.js";
import { toProviderSessionRef } from "./types.js";

export function makeProviderSessionRef(
  provider: AgentProvider,
  overrides: Partial<SessionInfo> = {},
): ProviderSessionRef {
  const now = new Date("2026-04-05T12:00:00.000Z");
  return toProviderSessionRef(provider, {
    id: "session-1",
    path: provider === "codex"
      ? "/tmp/.codex/sessions/2026/04/05/rollout-session-1.jsonl"
      : "/tmp/.claude/projects/demo/session-1.jsonl",
    projectPath: "/tmp/demo",
    createdAt: now,
    modifiedAt: now,
    sizeBytes: 100,
    ...overrides,
  });
}

export function makeTurn(overrides: Partial<TurnNode> = {}): TurnNode {
  return {
    id: "turn-0",
    index: 0,
    timestamp: new Date("2026-04-05T12:00:00.000Z"),
    summary: "Do work",
    category: "task",
    userInstruction: "Do work",
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
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    model: null,
    contextWindowTokens: null,
    durationMs: 1_000,
    events: [],
    startLine: 0,
    endLine: 1,
    ...overrides,
  };
}

export function makeParsedSession(
  session: SessionInfo,
  overrides: Partial<ParsedSession> = {},
): ParsedSession {
  const turns = overrides.turns ?? [makeTurn()];
  return {
    session,
    turns,
    stats: {
      totalEvents: 2,
      totalTurns: turns.length,
      toolCalls: 0,
      commits: 0,
      compactions: 0,
      filesChanged: [],
      toolsUsed: {},
      totalTokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      errorTurns: 0,
      correctionTurns: 0,
      primaryModel: null,
    },
    ...overrides,
  };
}

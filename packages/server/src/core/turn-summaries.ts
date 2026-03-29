import type { TurnNode, TurnSummary } from "../types/index.js";

const DEFAULT_LIMIT = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Convert TurnNode[] into TurnSummary[] for the context recap panel.
 * Returns at most `limit` summaries, excludes turns older than 24h,
 * sorted newest first.
 */
export function buildTurnSummaries(
  turns: TurnNode[],
  limit: number = DEFAULT_LIMIT,
): TurnSummary[] {
  const cutoff = Date.now() - MAX_AGE_MS;

  const recent = turns
    .filter((t) => t.timestamp.getTime() > cutoff)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);

  return recent.map((t): TurnSummary => ({
    id: t.id,
    timestamp: t.timestamp.toISOString(),
    role: t.category === "system" ? "assistant" : (t.userInstruction ? "user" : "assistant"),
    userInstruction: t.userInstruction,
    assistantPreview: t.assistantPreview,
    goalSummary: t.sections.goal.summary || null,
    actionSummary: t.sections.actions.summary || null,
    filesChanged: t.filesChanged,
    hasCommit: t.hasCommit,
    commitMessage: t.commitMessage,
    hasError: t.hasError,
    model: t.model,
    tokenUsage: t.tokenUsage
      ? { input: t.tokenUsage.inputTokens, output: t.tokenUsage.outputTokens }
      : null,
  }));
}

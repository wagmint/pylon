import type { TurnNode, TurnSummary } from "../types/index.js";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface TurnSummaryResult {
  summaries: TurnSummary[];
  skippedTurnCount: number;
}

/**
 * Convert TurnNode[] into TurnSummary[] for the context recap panel.
 * Returns the initial prompt + last 3 turns (4 pairs max), newest first,
 * with the init prompt pinned at the bottom.
 */
export function buildTurnSummaries(
  turns: TurnNode[],
): TurnSummaryResult {
  const cutoff = Date.now() - MAX_AGE_MS;

  const recent = turns
    .filter((t) => t.timestamp.getTime() > cutoff)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (recent.length === 0) return { summaries: [], skippedTurnCount: 0 };

  // The init turn is the oldest (last after reverse sort)
  const initTurn = recent[recent.length - 1];
  // Last 3 turns (newest first) excluding the init turn
  const latestTurns = recent.length > 1 ? recent.slice(0, 3) : [];
  // If init turn is already in latestTurns, don't duplicate
  const initAlreadyIncluded = latestTurns.some((t) => t.id === initTurn.id);

  const selected = initAlreadyIncluded
    ? latestTurns
    : [...latestTurns, initTurn]; // init pinned at bottom (end of array)

  const skippedTurnCount = initAlreadyIncluded
    ? 0
    : recent.length - selected.length;

  const summaries: TurnSummary[] = [];

  for (const t of selected) {
    if (t.userInstruction) {
      summaries.push({
        id: `${t.id}-user`,
        timestamp: t.timestamp.toISOString(),
        role: "user",
        userInstruction: t.userInstruction,
        assistantPreview: "",
        goalSummary: null,
        actionSummary: null,
        filesChanged: [],
        hasCommit: false,
        commitMessage: null,
        hasError: false,
        model: null,
        tokenUsage: null,
      });
    }

    if (t.assistantPreview || t.sections.actions.summary || t.filesChanged.length > 0 || t.hasCommit || t.hasError) {
      summaries.push({
        id: `${t.id}-assistant`,
        timestamp: t.timestamp.toISOString(),
        role: "assistant",
        userInstruction: "",
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
      });
    }
  }

  return { summaries, skippedTurnCount };
}

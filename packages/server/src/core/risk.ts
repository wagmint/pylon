import type { ParsedSession, TurnNode, AgentRisk, WorkstreamRisk, SpinningSignal, RiskLevel, Agent, ModelUsage, SourceUsage } from "../types/index.js";
import { computeTurnCost } from "./pricing.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

function getRecordedTokens(turn: TurnNode): number {
  return turn.tokenUsage.inputTokens
    + turn.tokenUsage.outputTokens
    + turn.tokenUsage.cacheReadInputTokens
    + turn.tokenUsage.cacheCreationInputTokens;
}

/**
 * Compute risk analytics for a single agent session.
 */
export function computeAgentRisk(
  parsed: ParsedSession,
  errorHistory?: boolean[],
  accumulatedModelUsage?: Map<string, { source: "claude" | "codex"; tokens: number; turns: number }>,
): AgentRisk {
  const { turns, stats } = parsed;
  const totalTurns = turns.length;
  const source = parsed.session.path.includes("/.codex/") ? "codex" : "claude";

  // Error rate
  const errorRate = totalTurns > 0 ? stats.errorTurns / totalTurns : 0;

  // Correction ratio — of error turns, how many had corrections applied?
  const correctionRatio = stats.errorTurns > 0
    ? stats.correctionTurns / stats.errorTurns
    : 1; // No errors = perfect

  // Total tokens
  const totalTokens = stats.totalTokenUsage.inputTokens
    + stats.totalTokenUsage.outputTokens
    + stats.totalTokenUsage.cacheReadInputTokens
    + stats.totalTokenUsage.cacheCreationInputTokens;

  // Compaction proximity — heuristic based on recent avg input tokens per turn
  const recentTurns = turns.slice(-5);
  const avgInputPerTurn = recentTurns.length > 0
    ? recentTurns.reduce((sum, t) => sum + t.tokenUsage.inputTokens, 0) / recentTurns.length
    : 0;
  let compactionProximity: RiskLevel = "nominal";
  if (avgInputPerTurn > 150_000) compactionProximity = "critical";
  else if (avgInputPerTurn > 100_000) compactionProximity = "elevated";

  // File hotspots — files edited 3+ times
  const fileEditCounts = new Map<string, number>();
  for (const turn of turns) {
    for (const file of turn.filesChanged) {
      fileEditCounts.set(file, (fileEditCounts.get(file) ?? 0) + 1);
    }
  }
  const fileHotspots = [...fileEditCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file: shortPath(file), count }));

  // Spinning detection
  const spinningSignals = source === "codex"
    ? detectCodexSpinning(turns)
    : detectSpinning(turns);

  // Error trend — last 10 turns (use accumulated history if available for compaction continuity)
  const errorTrend = errorHistory
    ? errorHistory.slice(-10)
    : turns.slice(-10).map(t => t.hasError);

  // Overall risk = worst of all signals
  const overallRisk = computeOverallRisk(errorRate, correctionRatio, compactionProximity, spinningSignals, totalTurns);

  const modelMap = new Map<string, { source: "claude" | "codex"; tokens: number; turns: number }>();
  const sourceMap = new Map<"claude" | "codex", { tokenCount: number; turnCount: number }>();
  let costEstimate = 0;
  for (const turn of turns) {
    const tokenCount = getRecordedTokens(turn);
    costEstimate += computeTurnCost(turn.model, turn.tokenUsage);
    const sourceEntry = sourceMap.get(source) ?? { tokenCount: 0, turnCount: 0 };
    sourceEntry.tokenCount += tokenCount;
    sourceEntry.turnCount += 1;
    sourceMap.set(source, sourceEntry);
    if (turn.model) {
      const entry = modelMap.get(turn.model) ?? { source, tokens: 0, turns: 0 };
      entry.tokens += tokenCount;
      entry.turns += 1;
      modelMap.set(turn.model, entry);
    }
  }
  if (accumulatedModelUsage) {
    for (const [model, data] of accumulatedModelUsage) {
      const existing = modelMap.get(model);
      if (!existing || data.tokens > existing.tokens) {
        modelMap.set(model, { ...data });
      }
    }
  }

  const modelBreakdown: ModelUsage[] = [...modelMap.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([model, data]) => ({ model, source: data.source, tokenCount: data.tokens, turnCount: data.turns }));
  const sourceBreakdown: SourceUsage[] = [...sourceMap.entries()]
    .sort((a, b) => b[1].tokenCount - a[1].tokenCount)
    .map(([sourceName, data]) => ({ source: sourceName, tokenCount: data.tokenCount, turnCount: data.turnCount }));

  // ─── Time metrics ─────────────────────────────────────────────────────────
  // sessionDurationMs: use session.createdAt as start (survives compaction)
  // avgTurnTimeMs: computed from visible turn deltas (still useful post-compaction)
  let avgTurnTimeMs: number | null = null;
  const lastTurnTs = turns.length > 0 ? turns[turns.length - 1].timestamp.getTime() : 0;
  const sessionDurationMs = lastTurnTs > 0
    ? lastTurnTs - parsed.session.createdAt.getTime()
    : 0;

  if (turns.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < turns.length; i++) {
      deltas.push(turns[i].timestamp.getTime() - turns[i - 1].timestamp.getTime());
    }
    avgTurnTimeMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  }

  // ─── Context usage % — use the most recent turn's last API call as the best
  // approximation of current context window size (averaging dilutes the signal,
  // especially after compaction when older turns have small context)
  const lastTurn = turns[turns.length - 1];
  const currentContextTokens = lastTurn ? getLastCallContextSize(lastTurn) : 0;
  const contextWindowTokens =
    lastTurn && typeof lastTurn.contextWindowTokens === "number" && lastTurn.contextWindowTokens > 0
      ? lastTurn.contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const contextUsagePct = Math.min(100, Math.round(currentContextTokens / contextWindowTokens * 100));

  return {
    errorRate,
    correctionRatio,
    totalTokens,
    compactions: stats.compactions,
    compactionProximity,
    fileHotspots,
    spinningSignals,
    overallRisk,
    errorTrend,
    modelBreakdown,
    sourceBreakdown,
    contextUsagePct,
    contextTokens: currentContextTokens,
    avgTurnTimeMs,
    sessionDurationMs,
    costEstimate,
  };
}

/**
 * Detect spinning/off-rails patterns in turn history.
 */
export function detectSpinning(turns: TurnNode[]): SpinningSignal[] {
  const signals: SpinningSignal[] = [];
  const recent = turns.slice(-10);

  // Pattern 1: Error loop — consecutive turns with errors
  let consecutiveErrors = 0;
  for (const turn of recent) {
    if (turn.hasError) {
      consecutiveErrors++;
    } else {
      consecutiveErrors = 0;
    }
  }
  if (consecutiveErrors >= 3) {
    signals.push({
      pattern: "error_loop",
      level: consecutiveErrors >= 5 ? "critical" : "elevated",
      detail: `${consecutiveErrors} consecutive turns with errors`,
    });
  }

  // Pattern 2: File churn — same file edited 5+ times in last 10 turns
  const recentFileEdits = new Map<string, number>();
  for (const turn of recent) {
    for (const file of turn.filesChanged) {
      recentFileEdits.set(file, (recentFileEdits.get(file) ?? 0) + 1);
    }
  }
  for (const [file, count] of recentFileEdits) {
    if (count >= 5) {
      signals.push({
        pattern: "file_churn",
        level: count >= 8 ? "critical" : "elevated",
        detail: `${shortPath(file)} edited ${count} times in last ${recent.length} turns`,
      });
    }
  }

  // Pattern 3: Repeated tool — same tool+target called repeatedly in last 5 turns
  // Only flags Bash commands (retrying same command) — not Edit/Write (normal for multi-file features)
  // Excludes meta-tools (TaskCreate, TaskUpdate, Task, etc.) which are orchestration, not spinning
  const SPINNING_EXCLUDED_TOOLS = new Set([
    "Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit",
    "Task", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
    "EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "Skill",
  ]);
  const last5 = turns.slice(-5);
  const toolTargetCounts = new Map<string, number>();
  for (const turn of last5) {
    for (const call of turn.toolCalls) {
      if (SPINNING_EXCLUDED_TOOLS.has(call.name)) continue;
      const target = extractTarget(call);
      const key = `${call.name}:${target}`;
      toolTargetCounts.set(key, (toolTargetCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of toolTargetCounts) {
    if (count >= 4) {
      signals.push({
        pattern: "repeated_tool",
        level: "elevated",
        detail: `${key} called ${count} times in last 5 turns`,
      });
    }
  }

  // Pattern 4: Stuck — 5+ errors and 0 commits in last 10 turns
  const recentErrors = recent.filter(t => t.hasError).length;
  const recentCommits = recent.filter(t => t.hasCommit).length;
  if (recentErrors >= 5 && recentCommits === 0) {
    signals.push({
      pattern: "stuck",
      level: "critical",
      detail: `${recentErrors} errors, 0 commits in last ${recent.length} turns`,
    });
  }

  return signals;
}

/**
 * Detect spinning from stored DB evidence (turns, file_touches, commands, errors).
 * Scans ALL sliding windows to find the peak risk ever reached during the session,
 * not just the final state.
 */
export function detectSpinningFromStoredEvidence(params: {
  turns: Array<{ hasError: number; turnIndex: number }>;
  fileTouches: Array<{ filePath: string; action: string; turnIndex: number }>;
  commands: Array<{ commandText: string; turnIndex: number }>;
  errors: Array<{ toolName: string; message: string; turnIndex: number }>;
}): { riskPeak: "nominal" | "elevated" | "critical"; hadSpinning: boolean; spinningTypes: string[] } {
  const spinningTypes = new Set<string>();
  let peakOrd = 0; // 0=nominal, 1=elevated, 2=critical

  const sorted = [...params.turns].sort((a, b) => a.turnIndex - b.turnIndex);

  // ── Pattern 1: error_loop — max consecutive error streak across ALL turns ──
  let maxConsecutive = 0;
  let consecutive = 0;
  for (const t of sorted) {
    if (t.hasError) {
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else {
      consecutive = 0;
    }
  }
  if (maxConsecutive >= 3) {
    spinningTypes.add("error_loop");
    peakOrd = Math.max(peakOrd, maxConsecutive >= 5 ? 2 : 1);
  }

  // ── Pre-index evidence by turnIndex ──
  const writeTouchesByTurn = new Map<number, string[]>();
  for (const ft of params.fileTouches) {
    if (ft.action !== "write" && ft.action !== "edit") continue;
    const arr = writeTouchesByTurn.get(ft.turnIndex) ?? [];
    arr.push(ft.filePath);
    writeTouchesByTurn.set(ft.turnIndex, arr);
  }

  const commitTurnSet = new Set<number>();
  const commandsByTurn = new Map<number, string[]>();
  for (const c of params.commands) {
    if (/\bgit\s+commit\b/.test(c.commandText)) {
      commitTurnSet.add(c.turnIndex);
    }
    const normalized = c.commandText.replace(/\s+/g, " ").trim().slice(0, 80);
    const arr = commandsByTurn.get(c.turnIndex) ?? [];
    arr.push(normalized);
    commandsByTurn.set(c.turnIndex, arr);
  }

  // ── Sliding window patterns ──
  for (let i = 0; i < sorted.length; i++) {
    // 10-turn window for file_churn and stuck
    const w10 = sorted.slice(i, Math.min(i + 10, sorted.length));

    // Pattern 2: file_churn — same file edited 5+ times in any 10-turn window
    const fileCounts = new Map<string, number>();
    for (const t of w10) {
      for (const f of (writeTouchesByTurn.get(t.turnIndex) ?? [])) {
        fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
      }
    }
    for (const [, count] of fileCounts) {
      if (count >= 5) {
        spinningTypes.add("file_churn");
        peakOrd = Math.max(peakOrd, count >= 8 ? 2 : 1);
      }
    }

    // Pattern 3: stuck — 5+ error turns AND 0 commits in any 10-turn window
    const windowErrors = w10.filter(t => t.hasError).length;
    const windowHasCommit = w10.some(t => commitTurnSet.has(t.turnIndex));
    if (windowErrors >= 5 && !windowHasCommit) {
      spinningTypes.add("stuck");
      peakOrd = Math.max(peakOrd, 2);
    }

    // Pattern 4: repeated_tool — same command 4+ times in any 5-turn window
    if (i + 5 <= sorted.length) {
      const w5 = sorted.slice(i, i + 5);
      const cmdCounts = new Map<string, number>();
      for (const t of w5) {
        for (const cmd of (commandsByTurn.get(t.turnIndex) ?? [])) {
          cmdCounts.set(cmd, (cmdCounts.get(cmd) ?? 0) + 1);
        }
      }
      for (const [, count] of cmdCounts) {
        if (count >= 4) {
          spinningTypes.add("repeated_tool");
          peakOrd = Math.max(peakOrd, 1);
        }
      }
    }
  }

  // ── Error rate contribution to risk peak ──
  const totalTurns = params.turns.length;
  const totalErrors = params.turns.filter(t => t.hasError).length;
  const errorRate = totalTurns > 0 ? totalErrors / totalTurns : 0;
  const hasEnoughData = totalTurns >= 6;

  if (hasEnoughData && errorRate > 0.35) {
    peakOrd = Math.max(peakOrd, 2);
  } else if (hasEnoughData && errorRate > 0.20) {
    peakOrd = Math.max(peakOrd, 1);
  }

  const riskPeak = peakOrd === 2 ? "critical" : peakOrd === 1 ? "elevated" : "nominal";

  return {
    riskPeak,
    hadSpinning: spinningTypes.size > 0,
    spinningTypes: [...spinningTypes],
  };
}

function detectCodexSpinning(turns: TurnNode[]): SpinningSignal[] {
  const baseSignals = detectSpinning(turns);
  return baseSignals.filter((signal) => {
    if (signal.pattern !== "repeated_tool") return true;
    return !signal.detail.startsWith("file_patch:");
  });
}

/**
 * Compute workstream-level risk by aggregating agent risks.
 */
export function computeWorkstreamRisk(agents: Agent[]): WorkstreamRisk {
  if (agents.length === 0) {
    return { errorRate: 0, totalTokens: 0, riskyAgents: 0, overallRisk: "nominal" };
  }

  const totalTokens = agents.reduce((sum, a) => sum + a.risk.totalTokens, 0);
  const avgErrorRate = agents.reduce((sum, a) => sum + a.risk.errorRate, 0) / agents.length;
  const riskyAgents = agents.filter(a => a.risk.overallRisk !== "nominal").length;

  let overallRisk: RiskLevel = "nominal";
  if (agents.some(a => a.risk.overallRisk === "critical")) overallRisk = "critical";
  else if (agents.some(a => a.risk.overallRisk === "elevated")) overallRisk = "elevated";

  return { errorRate: avgErrorRate, totalTokens, riskyAgents, overallRisk };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeOverallRisk(
  errorRate: number,
  correctionRatio: number,
  compactionProximity: RiskLevel,
  spinningSignals: SpinningSignal[],
  totalTurns: number
): RiskLevel {
  // Any critical spinning signal → critical
  if (spinningSignals.some(s => s.level === "critical")) return "critical";

  // Error rate thresholds only meaningful with enough data (≥6 turns)
  // With 4 turns, 1 error = 25% which is noise, not a pattern
  const hasEnoughData = totalTurns >= 6;

  // High error rate with low correction → critical
  if (hasEnoughData && errorRate > 0.35 && correctionRatio < 0.4) return "critical";

  // Compaction proximity critical → critical
  if (compactionProximity === "critical") return "critical";

  // Elevated spinning signals
  if (spinningSignals.some(s => s.level === "elevated")) return "elevated";

  // Moderate error rate (only with sufficient data)
  if (hasEnoughData && errorRate > 0.20) return "elevated";

  // Low correction ratio when there are meaningful errors
  if (hasEnoughData && errorRate > 0.10 && correctionRatio < 0.4) return "elevated";

  // Elevated compaction proximity
  if (compactionProximity === "elevated") return "elevated";

  return "nominal";
}

/** Get context window size from the last API call in a turn (avoids aggregation inflation). */
function getLastCallContextSize(turn: TurnNode): number {
  for (let i = turn.events.length - 1; i >= 0; i--) {
    const evt = turn.events[i];
    if (evt.message.role === "assistant" && evt.usage) {
      return evt.usage.inputTokens + evt.usage.cacheReadInputTokens + evt.usage.cacheCreationInputTokens;
    }
  }
  // Fallback (Codex turns have no per-event SessionEvent envelopes):
  // cached_input_tokens in Codex is a subset of input_tokens, so avoid double-counting.
  const u = turn.tokenUsage;
  return Math.max(u.inputTokens, u.cacheReadInputTokens + u.cacheCreationInputTokens);
}

function shortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}

function extractTarget(call: { name: string; input: Record<string, unknown> }): string {
  if (typeof call.input.file_path === "string") return shortPath(call.input.file_path);
  if (typeof call.input.path === "string") return shortPath(call.input.path);
  if (typeof call.input.command === "string") {
    // Use enough of the command to distinguish different invocations
    // Normalize whitespace and trim
    const cmd = call.input.command.replace(/\s+/g, " ").trim();
    return cmd.slice(0, 80);
  }
  return "unknown";
}

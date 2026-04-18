// ─── Session Outcome Classification ──────────────────────────────────────────
//
// Pure function — no DB access, no side effects.

export interface ClassificationInput {
  totalTurns: number;
  totalCommits: number;
  hadSpinning: boolean;
  errorRate: number;
  hasPush: boolean;
  toolsUsed: Record<string, number>;
}

export interface ClassificationResult {
  outcome: string;
  isDeadEnd: boolean;
  deadEndReason: string | null;
}

const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);

function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

export function classifySessionOutcome(input: ClassificationInput): ClassificationResult {
  const { totalTurns, totalCommits, hadSpinning, errorRate, hasPush, toolsUsed } = input;

  // 1. Abandoned start — trivially short, no output
  if (totalTurns < 3 && totalCommits === 0 && !hasPush) {
    return { outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null };
  }

  // 2. Productive — has concrete output
  if (totalCommits > 0 || hasPush) {
    return { outcome: "productive", isDeadEnd: false, deadEndReason: null };
  }

  // 3. Research — read-heavy, low error rate, 3+ turns, no commits
  let totalCallCount = 0;
  let readOnlyCallCount = 0;
  for (const [tool, count] of Object.entries(toolsUsed)) {
    totalCallCount += count;
    if (isReadOnlyTool(tool)) {
      readOnlyCallCount += count;
    }
  }
  if (totalTurns >= 3 && totalCallCount > 0 && readOnlyCallCount > totalCallCount / 2 && errorRate < 0.3) {
    return { outcome: "research", isDeadEnd: false, deadEndReason: null };
  }

  // 4. Dead end: spinning — agent was detected spinning
  if (hadSpinning && totalTurns >= 3) {
    return { outcome: "dead_end:spinning", isDeadEnd: true, deadEndReason: "dead_end:spinning" };
  }

  // 5. Dead end: abandoned — long session with no output
  if (totalTurns >= 10) {
    return { outcome: "dead_end:abandoned", isDeadEnd: true, deadEndReason: "dead_end:abandoned" };
  }

  // 6. Fallback — short-ish session, no commits, not research, not spinning
  return { outcome: "abandoned_start", isDeadEnd: false, deadEndReason: null };
}

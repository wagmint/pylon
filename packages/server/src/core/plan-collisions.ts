import type {
  Agent,
  LocalPlanCollision,
  LocalPlanCollisionConfidence,
  LocalPlanCollisionSeverity,
  LocalPlanCollisionType,
  PlanTask,
  SessionPlan,
} from "../types/index.js";

interface PlanningSession {
  sessionId: string;
  operatorId: string;
  projectPath: string;
  label: string;
  observedAt: Date;
  planSummary: string | null;
  planMarkdown: string | null;
  tasks: PlanTask[];
}

const LOW_INFORMATION_TEXT = new Set([
  "continue",
  "try again",
  "okay go implement",
  "ok go implement",
  "fix it",
  "do it",
  "go implement",
]);

const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "with", "by",
  "from", "into", "at", "is", "are", "be", "this", "that", "it", "then",
]);

const CONTRADICTION_PATTERNS: Array<{ left: string[]; right: string[]; label: string }> = [
  { left: ["centralize"], right: ["inline"], label: "centralize vs inline" },
  { left: ["remove", "delete"], right: ["add", "introduce"], label: "remove vs add" },
  { left: ["consolidate"], right: ["split", "separate"], label: "consolidate vs split" },
  { left: ["server", "server-side"], right: ["client", "client-side"], label: "server-side vs client-side" },
  { left: ["migrate away"], right: ["build on", "extend"], label: "migrate away vs build on" },
];

function normalizeText(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLowInformation(text: string | null | undefined): boolean {
  const normalized = normalizeText(text);
  return !normalized || LOW_INFORMATION_TEXT.has(normalized);
}

function tokenize(text: string | null | undefined): string[] {
  return normalizeText(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function jaccard(a: string[], b: string[]): number {
  const aSet = new Set(a);
  const bSet = new Set(b);
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const item of aSet) {
    if (bSet.has(item)) intersection++;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function extractPlanSummary(plan: SessionPlan): string | null {
  if (plan.markdown) {
    const heading = plan.markdown.match(/^#\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    const firstLine = plan.markdown.split("\n").map((line) => line.trim()).find(Boolean);
    if (firstLine) return firstLine;
  }
  const firstTask = plan.tasks.find((task) => !isLowInformation(task.subject));
  return firstTask?.subject ?? null;
}

function latestPlanningSession(agent: Agent): PlanningSession | null {
  if (agent.agentType !== "claude" || !agent.isActive) return null;
  const candidates = agent.plans
    .filter((plan) => plan.isFromActiveSession)
    .filter((plan) => Boolean(plan.markdown) || plan.tasks.length > 0);
  if (candidates.length === 0) return null;

  const plan = [...candidates].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
  const tasks = plan.tasks.filter((task) => !isLowInformation(task.subject));
  const planSummary = extractPlanSummary(plan);
  if (!plan.markdown && tasks.length === 0) return null;

  return {
    sessionId: agent.sessionId,
    operatorId: agent.operatorId,
    projectPath: agent.projectPath,
    label: agent.label,
    observedAt: plan.timestamp,
    planSummary: isLowInformation(planSummary) ? null : planSummary,
    planMarkdown: plan.markdown,
    tasks,
  };
}

function sharedTaskSubjects(left: PlanningSession, right: PlanningSession): string[] {
  const matches: string[] = [];
  for (const leftTask of left.tasks) {
    const leftNorm = normalizeText(leftTask.subject);
    const leftTokens = tokenize(leftTask.subject);
    for (const rightTask of right.tasks) {
      const rightNorm = normalizeText(rightTask.subject);
      const rightTokens = tokenize(rightTask.subject);
      if (!leftNorm || !rightNorm) continue;
      if (leftNorm === rightNorm || jaccard(leftTokens, rightTokens) >= 0.75) {
        matches.push(leftTask.subject);
      }
    }
  }
  return unique(matches);
}

function sharedPlanTokens(left: PlanningSession, right: PlanningSession): string[] {
  const leftTokens = new Set([
    ...tokenize(left.planSummary),
    ...tokenize(left.planMarkdown),
    ...left.tasks.flatMap((task) => tokenize(task.subject)),
  ]);
  const rightTokens = new Set([
    ...tokenize(right.planSummary),
    ...tokenize(right.planMarkdown),
    ...right.tasks.flatMap((task) => tokenize(task.subject)),
  ]);
  const shared: string[] = [];
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared.push(token);
  }
  return shared;
}

function contradictionSignals(left: PlanningSession, right: PlanningSession): string[] {
  const leftText = normalizeText([left.planSummary, left.planMarkdown, ...left.tasks.map((task) => task.subject)].join(" "));
  const rightText = normalizeText([right.planSummary, right.planMarkdown, ...right.tasks.map((task) => task.subject)].join(" "));
  const sharedTargets = sharedPlanTokens(left, right);
  if (sharedTargets.length === 0) return [];

  const signals: string[] = [];
  for (const pattern of CONTRADICTION_PATTERNS) {
    const leftMatch = pattern.left.some((token) => leftText.includes(token));
    const rightMatch = pattern.right.some((token) => rightText.includes(token));
    const inverseLeftMatch = pattern.right.some((token) => leftText.includes(token));
    const inverseRightMatch = pattern.left.some((token) => rightText.includes(token));
    if ((leftMatch && rightMatch) || (inverseLeftMatch && inverseRightMatch)) {
      signals.push(pattern.label);
    }
  }
  return unique(signals);
}

function buildCollision(
  type: LocalPlanCollisionType,
  confidence: LocalPlanCollisionConfidence,
  severity: LocalPlanCollisionSeverity,
  left: PlanningSession,
  right: PlanningSession,
  explanation: string,
  matchingTasks: string[],
  conflictingSignals: string[],
): LocalPlanCollision {
  return {
    id: `local-plan-collision:${type}:${left.sessionId}:${right.sessionId}`,
    type,
    confidence,
    severity,
    projectPath: left.projectPath,
    sessionIds: [left.sessionId, right.sessionId],
    detectedAt: new Date(Math.max(left.observedAt.getTime(), right.observedAt.getTime())),
    summary: explanation,
    explanation,
    evidence: {
      leftPlanSummary: left.planSummary,
      rightPlanSummary: right.planSummary,
      matchingTasks,
      conflictingSignals,
    },
  };
}

function comparePlanningSessions(left: PlanningSession, right: PlanningSession): LocalPlanCollision | null {
  const matchingTasks = sharedTaskSubjects(left, right);
  const sharedTokens = sharedPlanTokens(left, right);
  const contradictions = contradictionSignals(left, right);

  if (contradictions.length > 0) {
    return buildCollision(
      "contradictory_plan",
      "high",
      "critical",
      left,
      right,
      `Conflicting plan approaches detected across ${left.label} and ${right.label}`,
      matchingTasks,
      contradictions,
    );
  }

  const leftSummaryTokens = tokenize(left.planSummary);
  const rightSummaryTokens = tokenize(right.planSummary);
  const summarySimilarity = jaccard(leftSummaryTokens, rightSummaryTokens);
  const strongSummaryMatch =
    summarySimilarity >= 0.6
    || sharedTokens.length >= 5
    || (
      summarySimilarity >= 0.45
      && sharedTokens.length >= 3
    );

  if (
    (matchingTasks.length > 0 && (summarySimilarity >= 0.7 || sharedTokens.length >= 4))
    || (matchingTasks.length === 0 && strongSummaryMatch)
  ) {
    return buildCollision(
      "duplicate_plan",
      "high",
      "warning",
      left,
      right,
      `Likely duplicate plan across ${left.label} and ${right.label}`,
      matchingTasks,
      [],
    );
  }

  if (
    matchingTasks.length > 0 ||
    sharedTokens.length >= 3 ||
    (sharedTokens.length >= 2 && summarySimilarity >= 0.4)
  ) {
    return buildCollision(
      "overlapping_task",
      matchingTasks.length > 0 ? "high" : "medium",
      "warning",
      left,
      right,
      `Likely overlapping planning work across ${left.label} and ${right.label}`,
      matchingTasks,
      [],
    );
  }

  return null;
}

export function detectLocalPlanCollisions(agents: Agent[]): LocalPlanCollision[] {
  const planningSessions = agents
    .map((agent) => latestPlanningSession(agent))
    .filter((session): session is PlanningSession => session !== null);

  const collisions: LocalPlanCollision[] = [];
  for (let i = 0; i < planningSessions.length; i++) {
    for (let j = i + 1; j < planningSessions.length; j++) {
      const left = planningSessions[i];
      const right = planningSessions[j];
      if (left.operatorId !== right.operatorId) continue;
      if (left.projectPath !== right.projectPath) continue;

      const collision = comparePlanningSessions(left, right);
      if (collision) collisions.push(collision);
    }
  }

  return collisions.sort((a, b) => {
    const severityOrder: Record<LocalPlanCollisionSeverity, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    };
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return a.summary.localeCompare(b.summary);
  });
}

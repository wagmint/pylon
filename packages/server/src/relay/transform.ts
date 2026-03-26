import { relative } from "path";
import type { DashboardState, Agent, SessionPlan, DraftingActivity, IntentTaskView } from "../types/index.js";
import type {
  OperatorState,
  RelayAgent,
  RelayPlanTask,
  RelaySessionPlan,
  RelayWorkstream,
  RelayCollision,
  RelayFeedEvent,
} from "./types.js";

/**
 * Transform local DashboardState into the relay OperatorState format,
 * filtered to only include data from selected project paths.
 */
export function transformToOperatorState(
  state: DashboardState,
  operatorName: string,
  operatorColor: string,
  filterProjects: string[],
): OperatorState {
  const projectSet = new Set(filterProjects);
  const matchesProject = (projectPath: string) => projectSet.has(projectPath);

  // Filter agents by selected projects
  const filteredAgents = state.agents.filter((a) => matchesProject(a.projectPath));
  const filteredSessionIds = new Set(filteredAgents.map((a) => a.sessionId));

  // Build relay agents
  const agents: RelayAgent[] = filteredAgents.map((a) => mapAgent(a));

  // Build relay workstreams (only for matching projects)
  const workstreams: RelayWorkstream[] = state.workstreams
    .filter((w) => matchesProject(w.projectPath))
    .map((w) => ({
      projectId: w.projectId,
      projectPath: w.projectPath,
      name: w.name,
      agentSessionIds: w.agents.map((a) => a.sessionId),
      completionPct: w.completionPct,
      totalTurns: w.totalTurns,
      completedTurns: w.completedTurns,
      hasCollision: w.hasCollision,
      commits: w.commits,
      errors: w.errors,
      plans: w.plans.map(serializePlan),
      planTasks: w.planTasks.map(serializePlanTask),
      risk: {
        errorRate: w.risk.errorRate,
        overallRisk: w.risk.overallRisk,
      },
      intentCoveragePct: w.intentCoveragePct,
      driftPct: w.driftPct,
      intentConfidence: w.intentConfidence,
      intentStatus: w.intentStatus,
      lastIntentUpdateAt: w.lastIntentUpdateAt ? serializeDate(w.lastIntentUpdateAt) : null,
      intentLanes: {
        inProgress: w.intentLanes.inProgress.map(serializeIntentTaskView),
        done: w.intentLanes.done.map(serializeIntentTaskView),
        unplanned: w.intentLanes.unplanned.map(serializeIntentTaskView),
      },
      driftReasons: w.driftReasons,
    }));

  // Filter collisions — include if any involved agent is in a selected project
  const collisions: RelayCollision[] = state.collisions
    .filter((c) => c.agents.some((a) => filteredSessionIds.has(a.sessionId)))
    .map((c) => ({
      id: c.id,
      filePath: c.filePath,
      agents: c.agents,
      severity: c.severity,
      ...(c.alertLevel ? { alertLevel: c.alertLevel } : {}),
      isCrossOperator: c.isCrossOperator,
      detectedAt: serializeDate(c.detectedAt),
    }));

  // Filter feed events — include if session or project matches
  const feed: RelayFeedEvent[] = state.feed
    .filter((ev) => matchesProject(ev.projectPath) || filteredSessionIds.has(ev.sessionId))
    .map((ev) => ({
      id: ev.id,
      type: ev.type,
      timestamp: serializeDate(ev.timestamp),
      agentLabel: ev.agentLabel,
      sessionId: ev.sessionId,
      projectPath: ev.projectPath,
      message: ev.message,
      operatorId: ev.operatorId,
      ...(ev.collisionId ? { collisionId: ev.collisionId } : {}),
      ...(ev.commitSha ? { commitSha: ev.commitSha } : {}),
      ...(ev.commitFiles ? { commitFiles: ev.commitFiles } : {}),
    }));

  // Find the self operator
  const selfOp = state.operators.find((o) => o.id === "self");

  return {
    operator: {
      id: selfOp?.id ?? "self",
      name: operatorName,
      color: operatorColor,
    },
    agents,
    workstreams,
    collisions,
    feed,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapAgent(a: Agent): RelayAgent {
  const topPlan = getTopPlan(a.plans);
  return {
    sessionId: a.sessionId,
    label: a.label,
    agentType: a.agentType,
    status: a.status,
    currentTask: a.currentTask,
    filesChanged: a.filesChanged.map(f => relative(a.projectPath, f)),
    uncommittedFiles: a.uncommittedFiles.map(f => relative(a.projectPath, f)),
    projectPath: a.projectPath,
    isActive: a.isActive,
    planStatus: topPlan?.status ?? "none",
    planTaskProgress: computePlanTaskProgress(topPlan),
    operatorId: a.operatorId,
    risk: {
      ...a.risk,
      spinningSignals: a.risk.spinningSignals.map((s) => ({
        pattern: s.pattern,
        level: s.level,
        detail: s.detail,
      })),
    },
    plans: a.plans.map(serializePlan),
  };
}

function serializePlan(p: SessionPlan): RelaySessionPlan {
  return {
    status: p.status,
    markdown: p.markdown,
    tasks: p.tasks,
    agentLabel: p.agentLabel,
    timestamp: serializeDate(p.timestamp),
    planDurationMs: p.planDurationMs,
    draftingActivity: p.draftingActivity
      ? serializeDraftingActivity(p.draftingActivity)
      : null,
    isFromActiveSession: p.isFromActiveSession,
  };
}

function serializePlanTask(task: RelayPlanTask): RelayPlanTask {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
  };
}

function serializeDraftingActivity(d: DraftingActivity) {
  return {
    filesExplored: d.filesExplored,
    searches: d.searches,
    toolCounts: d.toolCounts,
    approachSummary: d.approachSummary,
    lastActivityAt: serializeDate(d.lastActivityAt),
    turnCount: d.turnCount,
  };
}

function serializeIntentTaskView(task: IntentTaskView) {
  return {
    id: task.id,
    subject: task.subject,
    state: task.state,
    ownerLabel: task.ownerLabel,
    ownerSessionId: task.ownerSessionId,
    evidence: {
      edits: task.evidence.edits,
      commits: task.evidence.commits,
      lastTouchedAt: task.evidence.lastTouchedAt ? serializeDate(task.evidence.lastTouchedAt) : null,
    },
  };
}

/**
 * Get the most relevant plan: latest non-"none" plan, or the last one.
 */
function getTopPlan(plans: SessionPlan[]): SessionPlan | null {
  if (plans.length === 0) return null;
  // Prefer the latest plan that has an active status
  for (let i = plans.length - 1; i >= 0; i--) {
    if (plans[i].status !== "none") return plans[i];
  }
  return plans[plans.length - 1];
}

/**
 * Compute plan task progress string like "3/5".
 */
function computePlanTaskProgress(plan: SessionPlan | null): string | null {
  if (!plan || plan.tasks.length === 0) return null;
  const completed = plan.tasks.filter((t) => t.status === "completed").length;
  const total = plan.tasks.filter((t) => t.status !== "deleted").length;
  if (total === 0) return null;
  return `${completed}/${total}`;
}

function serializeDate(d: Date): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

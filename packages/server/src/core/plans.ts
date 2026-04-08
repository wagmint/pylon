import type {
  ParsedSession, SessionPlan, PlanStatus, PlanTask, DraftingActivity,
} from "../types/index.js";

// ─── Plan builder ────────────────────────────────────────────────────────────

export function finalizePlan(
  tasks: PlanTask[],
  taskStatuses: Map<string, string>,
  markdown: string | null,
  inPlanMode: boolean,
  planAccepted: boolean,
  planRejected: boolean,
  agentLabel: string,
  timestamp: Date,
  planStartedAt: Date,
  planDurationMs: number | null,
  draftingActivity: DraftingActivity | null,
  postAcceptEdits: boolean,
  postAcceptCommit: boolean,
): SessionPlan | null {
  // Apply final statuses
  for (const task of tasks) {
    const latest = taskStatuses.get(task.id);
    if (latest === "completed" || latest === "in_progress" || latest === "pending" || latest === "deleted") {
      task.status = latest;
    }
  }

  const activeTasks = tasks.filter(t => t.status !== "deleted");

  // Determine status — tasks are the ground truth
  let status: PlanStatus = "none";

  if (activeTasks.length > 0) {
    if (activeTasks.every(t => t.status === "completed")) {
      status = "completed";
    } else if (activeTasks.some(t => t.status === "in_progress" || t.status === "completed")) {
      status = "implementing";
    } else {
      status = "drafting";
    }
  } else if (markdown || inPlanMode || planAccepted || planRejected) {
    if (planRejected) {
      status = "rejected";
    } else if (postAcceptCommit) {
      status = "completed";
    } else if (postAcceptEdits) {
      status = "implementing";
    } else if (inPlanMode || planAccepted || markdown) {
      status = "drafting";
    }
  }

  if (status === "none") return null;

  // Only attach drafting activity when status is "drafting"
  const activity = status === "drafting" ? draftingActivity : null;

  return { status, markdown, tasks: activeTasks, agentLabel, timestamp, planStartedAt, planDurationMs, draftingActivity: activity, isFromActiveSession: false };
}

export function buildSessionPlans(parsed: ParsedSession, agentLabel: string): SessionPlan[] {
  const finalized: SessionPlan[] = [];

  // Current plan cycle accumulator
  let markdown: string | null = null;
  let planAccepted = false;
  let planRejected = false;
  let inPlanMode = false;
  let lastPlanTs: Date = parsed.session.createdAt;
  let planStartTs: Date | null = null;
  let cycleStartedAt: Date = parsed.session.createdAt; // stable identity anchor
  let planDurationMs: number | null = null;
  let tasks: PlanTask[] = [];
  let taskStatuses = new Map<string, string>();

  // Post-acceptance activity signals (for task-less plans)
  let postAcceptEdits = false;
  let postAcceptCommit = false;

  // Drafting activity accumulator
  let draftFiles: Set<string> = new Set();
  let draftSearches: string[] = [];
  let draftToolCounts: Record<string, number> = {};
  let draftApproach = "";
  let draftLastActivity: Date | null = null;
  let draftTurnCount = 0;

  function resetDraftingActivity(): void {
    draftFiles = new Set();
    draftSearches = [];
    draftToolCounts = {};
    draftApproach = "";
    draftLastActivity = null;
    draftTurnCount = 0;
  }

  function buildDraftingActivity(): DraftingActivity | null {
    if (draftTurnCount === 0) return null;
    return {
      filesExplored: [...draftFiles],
      searches: draftSearches,
      toolCounts: { ...draftToolCounts },
      approachSummary: draftApproach,
      lastActivityAt: draftLastActivity!,
      turnCount: draftTurnCount,
    };
  }

  for (const turn of parsed.turns) {
    if (turn.hasPlanStart) {
      // Finalize current plan cycle (if it has any content)
      const plan = finalizePlan(tasks, taskStatuses, markdown, inPlanMode, planAccepted, planRejected, agentLabel, lastPlanTs, cycleStartedAt, planDurationMs, buildDraftingActivity(), postAcceptEdits, postAcceptCommit);
      if (plan) finalized.push(plan);

      // Start fresh cycle
      tasks = [];
      taskStatuses = new Map();
      markdown = null;
      inPlanMode = true;
      planAccepted = false;
      planRejected = false;
      postAcceptEdits = false;
      postAcceptCommit = false;
      lastPlanTs = turn.timestamp;
      planStartTs = turn.timestamp;
      cycleStartedAt = turn.timestamp;
      planDurationMs = null;
      resetDraftingActivity();
    }
    if (turn.hasPlanEnd && !turn.planRejected) {
      inPlanMode = false;
      planAccepted = true;
      planRejected = false;
      markdown = turn.planMarkdown ?? markdown;
      lastPlanTs = turn.timestamp;
      if (planStartTs) {
        planDurationMs = turn.timestamp.getTime() - planStartTs.getTime();
      }
    }
    if (turn.hasPlanEnd && turn.planRejected) {
      inPlanMode = false;
      planAccepted = false;
      planRejected = true;
      lastPlanTs = turn.timestamp;
      planDurationMs = null;
    }

    // Accumulate drafting activity while in plan mode
    if (inPlanMode) {
      draftTurnCount++;
      draftLastActivity = turn.timestamp;

      for (const f of turn.filesRead) draftFiles.add(f);

      for (const s of turn.sections.research.searches) draftSearches.push(s);

      for (const [tool, count] of Object.entries(turn.toolCounts)) {
        draftToolCounts[tool] = (draftToolCounts[tool] ?? 0) + count;
      }

      if (turn.sections.approach.summary) {
        draftApproach = turn.sections.approach.summary;
      }
    }

    // Track post-acceptance activity for task-less plans
    // Fires for both ExitPlanMode-accepted plans and planContent-sourced plans
    if ((planAccepted || markdown) && !inPlanMode) {
      if (turn.filesChanged.length > 0) postAcceptEdits = true;
      if (turn.hasCommit) postAcceptCommit = true;
    }

    // Cross-session plan: planMarkdown from JSONL envelope
    if (turn.planMarkdown && !markdown) {
      markdown = turn.planMarkdown;
      lastPlanTs = turn.timestamp;
    }

    for (const tc of turn.taskCreates) {
      if (tc.taskId) {
        tasks.push({
          id: tc.taskId,
          subject: tc.subject,
          description: tc.description,
          status: "pending",
        });
        lastPlanTs = turn.timestamp;
      }
    }

    for (const tu of turn.taskUpdates) {
      taskStatuses.set(tu.taskId, tu.status);
      lastPlanTs = turn.timestamp;
    }
  }

  // Finalize the last plan cycle
  const lastPlan = finalizePlan(tasks, taskStatuses, markdown, inPlanMode, planAccepted, planRejected, agentLabel, lastPlanTs, cycleStartedAt, planDurationMs, buildDraftingActivity(), postAcceptEdits, postAcceptCommit);
  if (lastPlan) finalized.push(lastPlan);

  return finalized;
}

/**
 * Build canonical session plans with accumulator fallback.
 * If the current parse yields no plans but the accumulator has prior plans
 * (e.g. from before a compaction), fall back to the accumulated plans.
 */
export function buildCanonicalSessionPlans(
  parsed: ParsedSession,
  label: string,
  isActive: boolean,
  priorPlans?: SessionPlan[],
): SessionPlan[] {
  let plans = buildSessionPlans(parsed, label);
  if (plans.length === 0 && priorPlans?.length) {
    plans = priorPlans.map((plan) => ({ ...plan, agentLabel: label }));
  }
  return plans.map((plan) => ({ ...plan, isFromActiveSession: isActive }));
}

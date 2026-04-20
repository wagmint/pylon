import { describe, it, expect } from "vitest";
import { deriveContextMap } from "./derive";
import type { DashboardState, Workstream, Agent, PlanTask, SessionPlan } from "../types";

function makePlanTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: "pt-1",
    subject: "Design schema",
    description: "Design the context schema",
    status: "in_progress",
    ...overrides,
  };
}

function makePlan(tasks: PlanTask[], overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    status: "implementing",
    markdown: null,
    tasks,
    agentLabel: "agent-1",
    timestamp: new Date().toISOString(),
    planDurationMs: null,
    draftingActivity: null,
    isFromActiveSession: true,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    sessionId: "sess-1",
    label: "agent-1",
    agentType: "claude",
    status: "busy",
    currentTask: "Working",
    filesChanged: [],
    projectPath: "/project",
    isActive: true,
    plans: [],
    risk: {
      errorRate: 0,
      correctionRatio: 0,
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
    },
    operatorId: "op-1",
    recentTurns: [],
    skippedTurnCount: 0,
    ...overrides,
  };
}

function makeWorkstream(
  agents: Agent[],
  planTasks: PlanTask[],
  overrides: Partial<Workstream> = {}
): Workstream {
  return {
    projectId: "proj-1",
    projectPath: "/project",
    name: "My Project",
    agents,
    completionPct: 0,
    totalTurns: 0,
    completedTurns: 0,
    hasCollision: false,
    commits: 0,
    errors: 0,
    plans: [makePlan(planTasks)],
    planTasks,
    risk: { errorRate: 0, totalTokens: 0, riskyAgents: 0, overallRisk: "nominal" },
    intentCoveragePct: 0,
    driftPct: 0,
    intentConfidence: "low",
    intentStatus: "no_clear_intent",
    lastIntentUpdateAt: null,
    intentLanes: { inProgress: [], done: [], unplanned: [] },
    driftReasons: [],
    mode: "claude",
    totalCommands: 0,
    totalPatches: 0,
    ...overrides,
  };
}

function makeState(workstreams: Workstream[]): DashboardState {
  const agents = workstreams.flatMap((w) => w.agents);
  return {
    operators: [],
    agents,
    workstreams,
    collisions: [],
    localPlanCollisions: [],
    feed: [],
    summary: {
      totalAgents: agents.length,
      activeAgents: agents.filter((a) => a.isActive).length,
      totalCollisions: 0,
      criticalCollisions: 0,
      totalWorkstreams: workstreams.length,
      totalCommits: 0,
      totalErrors: 0,
      agentsAtRisk: 0,
      blockedAgents: 0,
      operatorCount: 0,
      totalTokens: 0,
      totalCost: 0,
    },
  };
}

describe("deriveContextMap", () => {
  it("returns empty context map when no workstreams", () => {
    const result = deriveContextMap(makeState([]));
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.handoffs).toEqual([]);
    expect(result.summary).toEqual({
      goals: 0,
      tasks: 0,
      activeTasks: 0,
      blockedTasks: 0,
      completedTasks: 0,
    });
  });

  it("creates goal node from workstream", () => {
    const ws = makeWorkstream([], []);
    const result = deriveContextMap(makeState([ws]));
    expect(result.nodes).toEqual([
      { id: "goal-proj-1", type: "goal", label: "My Project" },
    ]);
    expect(result.summary.goals).toBe(1);
  });

  it("creates task nodes from plan tasks", () => {
    const task1 = makePlanTask({ id: "pt-1", subject: "Task A", status: "in_progress" });
    const task2 = makePlanTask({ id: "pt-2", subject: "Task B", status: "completed" });
    const ws = makeWorkstream([], [task1, task2]);
    const result = deriveContextMap(makeState([ws]));

    const taskNodes = result.nodes.filter((n) => n.type === "task");
    expect(taskNodes).toHaveLength(2);
    expect(taskNodes[0]).toMatchObject({
      id: "task-pt-1",
      type: "task",
      label: "Task A",
      status: "active",
    });
    expect(taskNodes[1]).toMatchObject({
      id: "task-pt-2",
      type: "task",
      label: "Task B",
      status: "completed",
    });
  });

  it("maps pending plan task status to handoff_ready", () => {
    const task = makePlanTask({ id: "pt-1", status: "pending" });
    const ws = makeWorkstream([], [task]);
    const result = deriveContextMap(makeState([ws]));
    const taskNode = result.nodes.find((n) => n.id === "task-pt-1");
    expect(taskNode?.status).toBe("handoff_ready");
  });

  it("creates session nodes from agents", () => {
    const agent = makeAgent({ sessionId: "sess-1", label: "morpheus", agentType: "claude", status: "busy" });
    const ws = makeWorkstream([agent], []);
    const result = deriveContextMap(makeState([ws]));

    const sessionNodes = result.nodes.filter((n) => n.type === "session");
    expect(sessionNodes).toHaveLength(1);
    expect(sessionNodes[0]).toMatchObject({
      id: "session-sess-1",
      type: "session",
      label: "morpheus",
      agentType: "claude",
      agentStatus: "busy",
    });
  });

  it("creates parent edges from goal to tasks", () => {
    const task = makePlanTask({ id: "pt-1" });
    const ws = makeWorkstream([], [task]);
    const result = deriveContextMap(makeState([ws]));

    const goalToTask = result.edges.filter(
      (e) => e.source === "goal-proj-1" && e.target === "task-pt-1"
    );
    expect(goalToTask).toHaveLength(1);
    expect(goalToTask[0]).toMatchObject({ type: "parent", declared: true });
  });

  it("creates parent edges from tasks to sessions via intentLanes", () => {
    const agent = makeAgent({ sessionId: "sess-1", label: "agent-1" });
    const task = makePlanTask({ id: "pt-1" });
    const ws = makeWorkstream([agent], [task], {
      intentLanes: {
        inProgress: [{
          id: "pt-1",
          subject: "Design schema",
          state: "in_progress",
          ownerLabel: "agent-1",
          ownerSessionId: "sess-1",
          evidence: { edits: 0, commits: 0, lastTouchedAt: null },
        }],
        done: [],
        unplanned: [],
      },
    });
    const result = deriveContextMap(makeState([ws]));

    const taskToSession = result.edges.filter(
      (e) => e.source === "task-pt-1" && e.target === "session-sess-1"
    );
    expect(taskToSession).toHaveLength(1);
  });

  it("falls back to linking sessions to workstream goal when no intent match", () => {
    const agent = makeAgent({ sessionId: "sess-1" });
    const ws = makeWorkstream([agent], []);
    const result = deriveContextMap(makeState([ws]));

    const goalToSession = result.edges.filter(
      (e) => e.source === "goal-proj-1" && e.target === "session-sess-1"
    );
    expect(goalToSession).toHaveLength(1);
  });

  it("deduplicates task nodes by id", () => {
    const task = makePlanTask({ id: "pt-1", subject: "Same Task" });
    const plan1 = makePlan([task], { agentLabel: "agent-1" });
    const plan2 = makePlan([task], { agentLabel: "agent-2" });
    const ws = makeWorkstream([], [task], {
      plans: [plan1, plan2],
    });
    const result = deriveContextMap(makeState([ws]));

    const taskNodes = result.nodes.filter((n) => n.type === "task");
    expect(taskNodes).toHaveLength(1);
  });

  it("filters out deleted tasks", () => {
    const task = makePlanTask({ id: "pt-1", status: "deleted" });
    const ws = makeWorkstream([], [task]);
    const result = deriveContextMap(makeState([ws]));

    const taskNodes = result.nodes.filter((n) => n.type === "task");
    expect(taskNodes).toHaveLength(0);
  });

  it("generates handoff for each task", () => {
    const task = makePlanTask({ id: "pt-1", subject: "My Task", status: "in_progress" });
    const ws = makeWorkstream([], [task]);
    const result = deriveContextMap(makeState([ws]));

    expect(result.handoffs).toHaveLength(1);
    expect(result.handoffs[0]).toEqual({
      taskId: "task-pt-1",
      subject: "My Task",
      status: "active",
      history: [],
      knowledge: [],
      blockers: [],
      nextStep: null,
    });
  });

  it("computes summary correctly", () => {
    const tasks = [
      makePlanTask({ id: "pt-1", status: "in_progress" }),
      makePlanTask({ id: "pt-2", status: "completed" }),
      makePlanTask({ id: "pt-3", status: "pending" }),
    ];
    const ws = makeWorkstream([], tasks);
    const result = deriveContextMap(makeState([ws]));

    expect(result.summary).toEqual({
      goals: 1,
      tasks: 3,
      activeTasks: 1,
      blockedTasks: 0,
      completedTasks: 1,
    });
  });

  it("overrides task status to blocked when agent is blocked", () => {
    const agent = makeAgent({ sessionId: "sess-1", label: "agent-1", status: "blocked" });
    const task = makePlanTask({ id: "pt-1", status: "in_progress" });
    const ws = makeWorkstream([agent], [task], {
      intentLanes: {
        inProgress: [{
          id: "pt-1",
          subject: "Design schema",
          state: "in_progress",
          ownerLabel: "agent-1",
          ownerSessionId: "sess-1",
          evidence: { edits: 0, commits: 0, lastTouchedAt: null },
        }],
        done: [],
        unplanned: [],
      },
    });
    const result = deriveContextMap(makeState([ws]));

    const taskNode = result.nodes.find((n) => n.id === "task-pt-1");
    expect(taskNode?.status).toBe("blocked");
  });
});

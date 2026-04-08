import type { DashboardState } from "../types";
import type { ContextMap, ContextNode, ContextEdge, TaskHandoff, TaskStatus } from "./types";

function mapPlanTaskStatus(
  planStatus: string,
  blockedSessionIds: Set<string>,
  ownerSessionId: string | null
): TaskStatus {
  if (ownerSessionId && blockedSessionIds.has(ownerSessionId)) return "blocked";
  switch (planStatus) {
    case "completed":
      return "completed";
    case "in_progress":
      return "active";
    case "pending":
      return "handoff_ready";
    default:
      return "active";
  }
}

export function deriveContextMap(state: DashboardState): ContextMap {
  const nodes: ContextNode[] = [];
  const edges: ContextEdge[] = [];
  const handoffs: TaskHandoff[] = [];
  const seenTaskIds = new Set<string>();

  for (const ws of state.workstreams) {
    // Goal node
    const goalId = `goal-${ws.projectId}`;
    nodes.push({ id: goalId, type: "goal", label: ws.name });

    // Build intent lookup: taskId → ownerSessionId
    const intentOwners = new Map<string, string>();
    for (const lane of [ws.intentLanes.inProgress, ws.intentLanes.done, ws.intentLanes.unplanned]) {
      for (const intent of lane) {
        if (intent.ownerSessionId) {
          intentOwners.set(intent.id, intent.ownerSessionId);
        }
      }
    }

    // Blocked session ids in this workstream
    const blockedSessionIds = new Set(
      ws.agents.filter((a) => a.status === "blocked").map((a) => a.sessionId)
    );

    // Track which sessions are linked to a task
    const linkedSessionIds = new Set<string>();

    // Task nodes from planTasks (deduplicated)
    for (const pt of ws.planTasks) {
      if (pt.status === "deleted") continue;
      if (seenTaskIds.has(pt.id)) continue;
      seenTaskIds.add(pt.id);

      const taskId = `task-${pt.id}`;
      const ownerSessionId = intentOwners.get(pt.id) ?? null;
      const status = mapPlanTaskStatus(pt.status, blockedSessionIds, ownerSessionId);

      // Count sessions linked to this task
      let sessionCount = 0;
      for (const [intentId, sessId] of intentOwners) {
        if (intentId === pt.id) {
          sessionCount++;
          linkedSessionIds.add(sessId);
        }
      }

      nodes.push({ id: taskId, type: "task", label: pt.subject, status, sessionCount });

      // Goal → Task edge
      edges.push({
        id: `edge-${goalId}-${taskId}`,
        source: goalId,
        target: taskId,
        type: "parent",
        declared: true,
      });

      // Task → Session edges (via intent)
      if (ownerSessionId) {
        const sessionNodeId = `session-${ownerSessionId}`;
        edges.push({
          id: `edge-${taskId}-${sessionNodeId}`,
          source: taskId,
          target: sessionNodeId,
          type: "parent",
          declared: true,
        });
      }

      // Handoff
      handoffs.push({
        taskId,
        subject: pt.subject,
        status,
        history: [],
        knowledge: [],
        blockers: [],
        nextStep: null,
      });
    }

    // Session nodes from agents
    for (const agent of ws.agents) {
      const sessionNodeId = `session-${agent.sessionId}`;
      nodes.push({
        id: sessionNodeId,
        type: "session",
        label: agent.label,
        agentType: agent.agentType,
        agentStatus: agent.status,
      });

      // If session not linked to any task, link to goal
      if (!linkedSessionIds.has(agent.sessionId)) {
        edges.push({
          id: `edge-${goalId}-${sessionNodeId}`,
          source: goalId,
          target: sessionNodeId,
          type: "parent",
          declared: true,
        });
      }
    }
  }

  // Summary
  const taskNodes = nodes.filter((n) => n.type === "task");
  const summary = {
    goals: nodes.filter((n) => n.type === "goal").length,
    tasks: taskNodes.length,
    activeTasks: taskNodes.filter((n) => n.status === "active").length,
    blockedTasks: taskNodes.filter((n) => n.status === "blocked").length,
    completedTasks: taskNodes.filter((n) => n.status === "completed").length,
  };

  return { nodes, edges, handoffs, summary };
}

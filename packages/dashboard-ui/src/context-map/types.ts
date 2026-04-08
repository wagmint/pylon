import type { AgentType, AgentStatus } from "../types";

export type ContextNodeType = "goal" | "task" | "session";

export type TaskStatus = "active" | "blocked" | "handoff_ready" | "completed";

export interface ContextNode {
  id: string;
  type: ContextNodeType;
  label: string;
  status?: TaskStatus;
  agentType?: AgentType;
  agentStatus?: AgentStatus;
  sessionCount?: number;
}

export interface ContextEdge {
  id: string;
  source: string;
  target: string;
  type: "parent" | "depends_on" | "continues" | "spawned" | "similar_scope";
  declared: boolean;
}

export interface TaskHandoff {
  taskId: string;
  subject: string;
  status: TaskStatus;
  history: string[];
  knowledge: string[];
  blockers: string[];
  nextStep: string | null;
}

export interface ContextMapSummary {
  goals: number;
  tasks: number;
  activeTasks: number;
  blockedTasks: number;
  completedTasks: number;
}

export interface ContextMap {
  nodes: ContextNode[];
  edges: ContextEdge[];
  handoffs: TaskHandoff[];
  summary: ContextMapSummary;
}

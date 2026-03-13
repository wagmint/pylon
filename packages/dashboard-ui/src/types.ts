// ─── Risk Types ──────────────────────────────────────────────────────────────

export type RiskLevel = "nominal" | "elevated" | "critical";

export interface SpinningSignal {
  pattern: string;
  level: RiskLevel;
  detail: string;
}

export interface ModelCost {
  model: string;
  cost: number;
  tokenCount: number;
  turnCount: number;
}

export interface AgentRisk {
  errorRate: number;
  correctionRatio: number;
  totalTokens: number;
  compactions: number;
  compactionProximity: RiskLevel;
  fileHotspots: Array<{ file: string; count: number }>;
  spinningSignals: SpinningSignal[];
  overallRisk: RiskLevel;
  errorTrend: boolean[];
  costPerSession: number;
  costPerTurn: number;
  peakTurnCost: number;
  modelBreakdown: ModelCost[];
  contextUsagePct: number;
  contextTokens: number;
  avgTurnTimeMs: number | null;
  sessionDurationMs: number;
}

export interface WorkstreamRisk {
  errorRate: number;
  totalTokens: number;
  riskyAgents: number;
  overallRisk: RiskLevel;
}

export interface IntentEvidence {
  edits: number;
  commits: number;
  lastTouchedAt: string | null;
}

export interface IntentTaskView {
  id: string;
  subject: string;
  state: "pending" | "in_progress" | "completed" | "blocked" | "unplanned";
  ownerLabel: string | null;
  ownerSessionId: string | null;
  evidence: IntentEvidence;
}

export interface IntentLanes {
  inProgress: IntentTaskView[];
  done: IntentTaskView[];
  unplanned: IntentTaskView[];
}

// ─── Operator Types ─────────────────────────────────────────────────────────

export type OperatorStatus = "online" | "offline";

export interface Operator {
  id: string;
  name: string;
  color: string;
  status: OperatorStatus;
}

// ─── Dashboard Types ────────────────────────────────────────────────────────

export type PlanStatus = "drafting" | "implementing" | "completed" | "rejected" | "none";

export interface PlanTask {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface DraftingActivity {
  filesExplored: string[];
  searches: string[];
  toolCounts: Record<string, number>;
  approachSummary: string;
  lastActivityAt: string;
  turnCount: number;
}

export interface SessionPlan {
  status: PlanStatus;
  markdown: string | null;
  tasks: PlanTask[];
  agentLabel: string;
  timestamp: string;
  planDurationMs: number | null;
  draftingActivity: DraftingActivity | null;
  isFromActiveSession: boolean;
}

export type AgentStatus = "idle" | "busy" | "warning" | "conflict" | "blocked";

export type AgentType = "claude" | "codex";

export type WorkstreamMode = "claude" | "codex" | "mixed";

export interface Agent {
  sessionId: string;
  label: string;
  agentType: AgentType;
  status: AgentStatus;
  currentTask: string;
  filesChanged: string[];
  projectPath: string;
  isActive: boolean;
  plans: SessionPlan[];
  risk: AgentRisk;
  operatorId: string;
  blockedOn?: Array<{ requestId: string; toolName: string; description: string; detail?: string }>;
}

export interface Workstream {
  projectId: string;
  projectPath: string;
  name: string;
  agents: Agent[];
  completionPct: number;
  totalTurns: number;
  completedTurns: number;
  hasCollision: boolean;
  commits: number;
  errors: number;
  plans: SessionPlan[];
  planTasks: PlanTask[];
  risk: WorkstreamRisk;
  intentCoveragePct: number;
  driftPct: number;
  intentConfidence: "high" | "medium" | "low";
  intentStatus: "on_plan" | "drifting" | "blocked" | "no_clear_intent";
  lastIntentUpdateAt: string | null;
  intentLanes: IntentLanes;
  driftReasons: string[];
  mode: WorkstreamMode;
  totalCommands: number;
  totalPatches: number;
}

export type CollisionSeverity = "warning" | "critical";

export interface Collision {
  id: string;
  filePath: string;
  agents: {
    sessionId: string;
    label: string;
    projectPath: string;
    lastAction: string;
    operatorId: string;
  }[];
  severity: CollisionSeverity;
  isCrossOperator: boolean;
  detectedAt: string;
}

export type LocalPlanCollisionType =
  | "duplicate_plan"
  | "overlapping_task"
  | "contradictory_plan";

export type LocalPlanCollisionConfidence = "high" | "medium" | "low";

export type LocalPlanCollisionSeverity = "info" | "warning" | "critical";

export interface LocalPlanCollision {
  id: string;
  type: LocalPlanCollisionType;
  confidence: LocalPlanCollisionConfidence;
  severity: LocalPlanCollisionSeverity;
  projectPath: string;
  sessionIds: [string, string];
  detectedAt: string;
  summary: string;
  explanation: string;
  evidence: {
    leftPlanSummary: string | null;
    rightPlanSummary: string | null;
    matchingTasks: string[];
    conflictingSignals: string[];
  };
}

export type FeedEventType =
  | "collision"
  | "collision_resolved"
  | "commit"
  | "completion"
  | "error"
  | "compaction"
  | "start"
  | "plan_started"
  | "plan_approved"
  | "task_completed"
  | "session_ended"
  | "stall"
  | "idle"
  | "blocked"
  | "push";

export interface FeedEvent {
  id: string;
  type: FeedEventType;
  timestamp: string;
  agentLabel: string;
  sessionId: string;
  projectPath: string;
  operatorId: string;
  message: string;
  collisionId?: string;
}

export interface DashboardSummary {
  totalAgents: number;
  activeAgents: number;
  totalCollisions: number;
  criticalCollisions: number;
  totalWorkstreams: number;
  totalCommits: number;
  totalErrors: number;
  agentsAtRisk: number;
  blockedAgents: number;
  operatorCount: number;
  totalCost: number;
}

export interface DashboardState {
  operators: Operator[];
  agents: Agent[];
  workstreams: Workstream[];
  collisions: Collision[];
  localPlanCollisions: LocalPlanCollision[];
  feed: FeedEvent[];
  summary: DashboardSummary;
}

// ─── Relay Types ─────────────────────────────────────────────────────────────

export type RelayConnectionStatus = "connected" | "connecting" | "disconnected";

export interface RelayTargetInfo {
  hexcoreId: string;
  hexcoreName: string;
  status: RelayConnectionStatus;
  projects: string[];
  addedAt: string;
}

export interface ActiveProject {
  projectPath: string;
  sessionCount: number;
}

// Subset of @hexdeck/dashboard-ui types needed by the menubar app.
// Kept local to avoid pulling in the full dashboard-ui dependency.

export type RiskLevel = "nominal" | "elevated" | "critical";

export interface SpinningSignal {
  pattern: string;
  level: RiskLevel;
  detail: string;
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
  modelBreakdown: Array<{
    model: string;
    cost: number;
    tokenCount: number;
    turnCount: number;
  }>;
  contextUsagePct: number;
  contextTokens: number;
  avgTurnTimeMs: number | null;
  sessionDurationMs: number;
}

export type AgentStatus = "idle" | "busy" | "warning" | "conflict" | "blocked";
export type AgentType = "claude" | "codex";

export interface Agent {
  sessionId: string;
  label: string;
  agentType: AgentType;
  status: AgentStatus;
  currentTask: string;
  filesChanged: string[];
  projectPath: string;
  isActive: boolean;
  plans: unknown[];
  risk: AgentRisk;
  operatorId: string;
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

export type FeedEventType =
  | "collision"
  | "collision_resolved"
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
  | "blocked";

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
  operators: unknown[];
  agents: Agent[];
  workstreams: unknown[];
  collisions: Collision[];
  feed: FeedEvent[];
  summary: DashboardSummary;
}

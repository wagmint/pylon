// ─── Risk Types ──────────────────────────────────────────────────────────────

export type RiskLevel = "nominal" | "elevated" | "critical";

export interface SpinningSignal {
  pattern: string;
  level: RiskLevel;
  detail: string;
}

export interface ModelCost {
  model: string;       // Short name ("Sonnet 4")
  cost: number;        // $ for this model
  tokenCount: number;  // input+output tokens
  turnCount: number;   // turns using this model
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
  costPerSession: number;       // Total $ for this session
  costPerTurn: number;          // Average $/turn
  peakTurnCost: number;         // Max single-turn cost
  modelBreakdown: ModelCost[];  // Per-model cost split
  contextUsagePct: number;      // 0-100, % of context window used
  contextTokens: number;        // Raw avg input tokens (last 5 turns)
  avgTurnTimeMs: number | null; // avg of turn-to-turn deltas
  sessionDurationMs: number;    // last turn ts - first turn ts
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
  lastTouchedAt: Date | null;
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

// ─── Operator Types ──────────────────────────────────────────────────────────

export type OperatorStatus = "online" | "offline";

export interface Operator {
  /** "self" for local, "op-andrew" for configured */
  id: string;
  /** Display name: "Jake", "Andrew" */
  name: string;
  /** Hex color from palette */
  color: string;
  /** Online if any agents are active */
  status: OperatorStatus;
}

// ─── Dashboard Types ─────────────────────────────────────────────────────────

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
  lastActivityAt: Date;
  turnCount: number;
}

export interface SessionPlan {
  status: PlanStatus;
  markdown: string | null;
  tasks: PlanTask[];
  /** Agent label that owns this plan */
  agentLabel: string;
  /** When this plan was last updated (latest relevant turn timestamp) */
  timestamp: Date;
  /** Duration from plan start to plan end/approved (ms) */
  planDurationMs: number | null;
  /** Activity data accumulated during drafting phase (only when status === "drafting") */
  draftingActivity: DraftingActivity | null;
  /** Whether the owning agent's session is currently running */
  isFromActiveSession: boolean;
}

export type AgentStatus = "idle" | "busy" | "warning" | "conflict" | "blocked";

export type AgentType = "claude" | "codex";

export type WorkstreamMode = "claude" | "codex" | "mixed";

export interface Agent {
  /** Session ID */
  sessionId: string;
  /** Label within its project (agent-1, agent-2...) */
  label: string;
  /** Which CLI this agent comes from */
  agentType: AgentType;
  /** Current status */
  status: AgentStatus;
  /** Short description of current activity */
  currentTask: string;
  /** Files this agent has changed */
  filesChanged: string[];
  /** Currently uncommitted files in this agent's project */
  uncommittedFiles: string[];
  /** Project path this agent belongs to */
  projectPath: string;
  /** Whether this agent is currently active (has running process) */
  isActive: boolean;
  /** Plan states for this agent's session (one per plan cycle) */
  plans: SessionPlan[];
  /** Risk analytics */
  risk: AgentRisk;
  /** Operator this agent belongs to */
  operatorId: string;
  /** What the agent is blocked on when status === "blocked". Array supports multiple parallel tool calls. */
  blockedOn?: Array<{ requestId: string; toolName: string; description: string; detail?: string }>;
}

export interface Workstream {
  /** Encoded project name */
  projectId: string;
  /** Decoded project path */
  projectPath: string;
  /** Short display name (last path segment) */
  name: string;
  /** Agents working in this project */
  agents: Agent[];
  /** Completion percentage (completed turns / total turns) */
  completionPct: number;
  /** Total turns across all sessions */
  totalTurns: number;
  /** Turns with commits or completed work */
  completedTurns: number;
  /** Whether this workstream has collisions */
  hasCollision: boolean;
  /** Total commits across sessions */
  commits: number;
  /** Total errors across sessions */
  errors: number;
  /** Plans from agent sessions in this workstream */
  plans: SessionPlan[];
  /** Flattened tasks across all sessions */
  planTasks: PlanTask[];
  /** Workstream-level risk aggregation */
  risk: WorkstreamRisk;
  /** Planned task execution coverage (0-100) */
  intentCoveragePct: number;
  /** Estimated unplanned work share (0-100) */
  driftPct: number;
  /** Confidence in intent mapping quality */
  intentConfidence: "high" | "medium" | "low";
  /** Plan vs reality classification */
  intentStatus: "on_plan" | "drifting" | "blocked" | "no_clear_intent";
  /** Most recent intent-relevant update */
  lastIntentUpdateAt: Date | null;
  /** Plan vs reality lanes for intent map rendering */
  intentLanes: IntentLanes;
  /** Human-readable drift indicators */
  driftReasons: string[];
  /** Agent composition: claude-only, codex-only, or mixed */
  mode: WorkstreamMode;
  /** Total bash/shell commands across all agent turns */
  totalCommands: number;
  /** Total file patches (writes/edits) across all agent turns */
  totalPatches: number;
}

export type CollisionSeverity = "warning" | "critical";

export interface Collision {
  /** Unique ID for this collision */
  id: string;
  /** The file path that has a collision */
  filePath: string;
  /** Agents involved in the collision */
  agents: {
    sessionId: string;
    label: string;
    projectPath: string;
    /** What this agent last did to the file */
    lastAction: string;
    /** Operator this agent belongs to */
    operatorId: string;
  }[];
  /** Severity: critical if cross-project or cross-operator, warning if same project */
  severity: CollisionSeverity;
  /** Alert level for cross-operator collisions: yellow = uncommitted overlap, red = confirmed conflict */
  alertLevel?: "yellow" | "red";
  /** Whether this collision involves agents from different operators */
  isCrossOperator: boolean;
  /** Display timestamp */
  detectedAt: Date;
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
  detectedAt: Date;
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
  /** Unique ID for deduplication */
  id: string;
  /** Event type */
  type: FeedEventType;
  /** Display timestamp */
  timestamp: Date;
  /** Agent label (e.g. agent-1) */
  agentLabel: string;
  /** Session ID */
  sessionId: string;
  /** Project path */
  projectPath: string;
  /** Human-readable message */
  message: string;
  /** Operator this event belongs to */
  operatorId: string;
  /** Optional: collision ID if type is collision */
  collisionId?: string;
  /** Optional: commit SHA if type is commit */
  commitSha?: string;
  /** Optional: files changed in commit */
  commitFiles?: string[];
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
  totalCost: number;  // Sum across all active agents
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

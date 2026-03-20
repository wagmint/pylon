// ─── Relay Protocol Types ───────────────────────────────────────────────────
// Mirrors cloud's OperatorState shape independently (hexdeck can't import from hexdeck-cloud).

// ─── Relay State Types ──────────────────────────────────────────────────────

export interface RelayAgentRisk {
  errorRate: number;
  correctionRatio: number;
  totalTokens: number;
  compactions: number;
  compactionProximity: "nominal" | "elevated" | "critical";
  fileHotspots: { file: string; count: number }[];
  spinningSignals: { pattern: string; level: string; detail: string }[];
  overallRisk: "nominal" | "elevated" | "critical";
  errorTrend: boolean[];
  modelBreakdown: { model: string; source: "claude" | "codex"; tokenCount: number; turnCount: number }[];
  sourceBreakdown: { source: "claude" | "codex"; tokenCount: number; turnCount: number }[];
  contextUsagePct: number;
  contextTokens: number;
  avgTurnTimeMs: number | null;
  sessionDurationMs: number;
}

export interface RelayPlanTask {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface RelayDraftingActivity {
  filesExplored: string[];
  searches: string[];
  toolCounts: Record<string, number>;
  approachSummary: string;
  lastActivityAt: string; // ISO
  turnCount: number;
}

export interface RelaySessionPlan {
  status: "drafting" | "implementing" | "completed" | "rejected" | "none";
  markdown: string | null;
  tasks: RelayPlanTask[];
  agentLabel: string;
  timestamp: string; // ISO
  planDurationMs: number | null;
  draftingActivity: RelayDraftingActivity | null;
  isFromActiveSession: boolean;
}

export interface RelayAgent {
  sessionId: string;
  label: string;
  agentType: "claude" | "codex";
  status: "idle" | "busy" | "warning" | "conflict" | "blocked";
  currentTask: string;
  filesChanged: string[];
  uncommittedFiles: string[];
  projectPath: string;
  isActive: boolean;
  planStatus: "drafting" | "implementing" | "completed" | "rejected" | "none";
  planTaskProgress: string | null; // e.g. "3/5"
  operatorId: string;
  risk: RelayAgentRisk;
  plans: RelaySessionPlan[];
}

export interface RelayWorkstream {
  projectId: string;
  projectPath: string;
  name: string;
  agentSessionIds: string[];
  completionPct: number;
  totalTurns: number;
  completedTurns: number;
  hasCollision: boolean;
  commits: number;
  errors: number;
  plans: RelaySessionPlan[];
  planTasks: RelayPlanTask[];
  risk: { errorRate: number; overallRisk: "nominal" | "elevated" | "critical" };
  intentCoveragePct: number;
  driftPct: number;
  intentConfidence: "high" | "medium" | "low";
  intentStatus: "on_plan" | "drifting" | "blocked" | "no_clear_intent";
  lastIntentUpdateAt: string | null;
  intentLanes: {
    inProgress: RelayIntentTaskView[];
    done: RelayIntentTaskView[];
    unplanned: RelayIntentTaskView[];
  };
  driftReasons: string[];
}

export interface RelayIntentTaskView {
  id: string;
  subject: string;
  state: "pending" | "in_progress" | "completed" | "blocked" | "unplanned";
  ownerLabel: string | null;
  ownerSessionId: string | null;
  evidence: {
    edits: number;
    commits: number;
    lastTouchedAt: string | null;
  };
}

export interface RelayCollision {
  id: string;
  filePath: string;
  agents: {
    sessionId: string;
    label: string;
    projectPath: string;
    lastAction: string;
    operatorId: string;
  }[];
  severity: "warning" | "critical";
  alertLevel?: "yellow" | "red";
  isCrossOperator: boolean;
  detectedAt: string; // ISO
}

export type RelayFeedEventType =
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

export interface RelayFeedEvent {
  id: string;
  type: RelayFeedEventType;
  timestamp: string; // ISO
  agentLabel: string;
  sessionId: string;
  projectPath: string;
  message: string;
  operatorId: string;
  collisionId?: string;
  commitSha?: string;
  commitFiles?: string[];
}

export interface OperatorState {
  operator: {
    id: string;
    name: string;
    color: string;
  };
  agents: RelayAgent[];
  workstreams: RelayWorkstream[];
  collisions: RelayCollision[];
  feed: RelayFeedEvent[];
}

// ─── WebSocket Protocol ─────────────────────────────────────────────────────

// Client → Server messages
export interface AuthMessage {
  type: "auth";
  token: string;
  hexcoreId: string;
}

export interface StateUpdateMessage {
  type: "state_update";
  state: OperatorState;
}

export interface HeartbeatMessage {
  type: "heartbeat";
}

export interface CollisionAckMessage {
  type: "collision_ack";
  collisionId: string;
  action: "acknowledged" | "confirmed";
}

export type ClientMessage = AuthMessage | StateUpdateMessage | HeartbeatMessage | CollisionAckMessage;

// Server → Client messages
export interface AuthOkMessage {
  type: "auth_ok";
  operatorId: string;
}

export interface AuthErrorMessage {
  type: "auth_error";
  reason: string;
}

export interface MergedStateMessage {
  type: "merged_state";
  state: unknown;
}

export type ServerMessage = AuthOkMessage | AuthErrorMessage | MergedStateMessage;

// ─── Relay Config Types ─────────────────────────────────────────────────────

export interface RelayTarget {
  hexcoreId: string;
  hexcoreName: string;
  wsUrl: string;
  token: string;
  relayClientId: string;
  relayClientSecret: string;
  projects: string[];
  addedAt: string; // ISO
}

export interface RelayConfig {
  targets: RelayTarget[];
}

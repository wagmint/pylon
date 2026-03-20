export type {
  RiskLevel, SpinningSignal, ModelUsage, SourceUsage, AgentRisk, WorkstreamRisk,
  IntentEvidence, IntentTaskView, IntentLanes,
  OperatorStatus, Operator,
  PlanStatus, PlanTask, DraftingActivity, SessionPlan,
  AgentStatus, Agent, WorkstreamMode, Workstream, CollisionSeverity, Collision,
  LocalPlanCollisionType, LocalPlanCollisionConfidence, LocalPlanCollisionSeverity, LocalPlanCollision,
  FeedEventType, FeedEvent, DashboardSummary, DashboardState,
} from "./dashboard.js";

// ─── Token Usage ─────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

// ─── Claude Code JSONL Event Types ───────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface CompactionContent {
  type: "compaction";
  content: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export type ContentBlock =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | CompactionContent
  | ThinkingContent;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[] | string;
}

export interface SessionEvent {
  /** Line number in the JSONL file (0-indexed) */
  line: number;
  /** The parsed message */
  message: Message;
  /** Real timestamp from the JSONL envelope (ISO 8601) */
  timestamp?: Date;
  /** Plan content from ExitPlanMode approval (on the JSONL envelope) */
  planContent?: string;
  /** Token usage from the API response envelope */
  usage?: TokenUsage;
  /** Model used for this event */
  model?: string;
}

// ─── Session Discovery Types ─────────────────────────────────────────────────

export interface SessionInfo {
  /** Session UUID */
  id: string;
  /** Full path to the JSONL file */
  path: string;
  /** Project path this session belongs to */
  projectPath: string;
  /** File creation time */
  createdAt: Date;
  /** File modification time */
  modifiedAt: Date;
  /** File size in bytes */
  sizeBytes: number;
}

export interface ProjectInfo {
  /** Encoded project directory name (as stored by Claude Code) */
  encodedName: string;
  /** Decoded original path */
  decodedPath: string;
  /** Number of sessions */
  sessionCount: number;
  /** Most recent session date */
  lastActive: Date;
}

// ─── Tree Types (core data model) ────────────────────────────────────────────

export type NodeType =
  | "user_instruction"
  | "implementation"
  | "commit"
  | "compaction"
  | "error"
  | "decision_point"
  | "checkpoint";

export type NodeStatus = "good" | "uncertain" | "off_rails" | "checkpoint";

export interface Decision {
  what: string;
  why: string;
  alternatives: string[];
}

export interface TreeNode {
  id: string;
  sessionId: string;
  parentId: string | null;
  children: string[];
  branchId: string | null;

  /** Position in transcript */
  transcriptLine: number;
  timestamp: string;
  depth: number;

  /** Classification */
  type: NodeType;
  summary: string;

  /** State at this point */
  gitRef: string | null;
  filesChanged: string[];
  tokenCount: number;

  /** Decisions made at this node */
  decisions: Decision[];

  /** Visualization */
  status: NodeStatus;
  confidence: number;
}

export interface Branch {
  id: string;
  name: string;
  sourceNodeId: string;
  sessionId: string;
  createdAt: string;
  status: "active" | "merged" | "abandoned";
}

export interface CompactionSnapshot {
  id: string;
  nodeId: string;
  sessionId: string;
  preCompactSummary: string;
  decisionsSoFar: Decision[];
  activeTasks: string[];
  filesState: string;
  tokenCountBefore: number;
  createdAt: string;
}

export interface ResumeEvent {
  id: string;
  sourceNodeId: string;
  newSessionId: string;
  resumeMethod: "jsonl_truncate" | "briefing" | "hybrid";
  createdAt: string;
}

export interface SessionTree {
  sessionId: string;
  projectPath: string;
  nodes: TreeNode[];
  branches: Branch[];
  compactionSnapshots: CompactionSnapshot[];
  resumeEvents: ResumeEvent[];
  createdAt: string;
  updatedAt: string;
}

// ─── Turn-Pair Node Types (v0 data model) ───────────────────────────────────

export interface ToolCallSummary {
  name: string;
  input: Record<string, unknown>;
}

export type TurnCategory =
  | "task"         // "implement X", "build Y", "add Z"
  | "question"     // "how does X work?", "what is Y?"
  | "feedback"     // "this is wrong", "fix X", "change Y"
  | "command"      // /mcp, /insights, slash commands
  | "continuation" // "continue", "yes", "ok"
  | "interruption" // [Interrupted by user]
  | "context"      // pasting terminal output, sharing context
  | "system"       // system-generated messages
  | "conversation"; // general discussion, ideation

// ─── Turn Section Types ──────────────────────────────────────────────────────

export interface GoalSection {
  summary: string;
  fullInstruction: string;
}

export interface ApproachSection {
  summary: string;
  thinking: string;
}

export interface DecisionItem {
  choice: string;
  reasoning: string;
}

export interface DecisionsSection {
  summary: string;
  items: DecisionItem[];
}

export interface ResearchSection {
  summary: string;
  filesRead: string[];
  searches: string[];
}

export interface ActionsSection {
  summary: string;
  edits: string[];
  commands: string[];
  creates: string[];
}

export interface CorrectionItem {
  error: string;
  fix: string;
}

export interface CorrectionsSection {
  summary: string;
  items: CorrectionItem[];
}

export interface ArtifactsSection {
  summary: string;
  filesChanged: string[];
  commits: string[];
}

export interface EscalationsSection {
  summary: string;
  questions: string[];
}

export interface TurnSections {
  goal: GoalSection;
  approach: ApproachSection;
  decisions: DecisionsSection;
  research: ResearchSection;
  actions: ActionsSection;
  corrections: CorrectionsSection;
  artifacts: ArtifactsSection;
  escalations: EscalationsSection;
}

// ─── Turn Node ───────────────────────────────────────────────────────────────

export interface TurnNode {
  id: string;
  index: number;

  /** Real timestamp from the first event in this turn */
  timestamp: Date;

  /** Short scannable summary of the user's instruction */
  summary: string;
  /** Category of this turn */
  category: TurnCategory;
  /** The user's instruction text (cleaned, for detail panel) */
  userInstruction: string;
  /** Preview of Claude's response text (first ~200 chars) */
  assistantPreview: string;

  /** Semantic sections — progressive disclosure */
  sections: TurnSections;

  /** Tool calls made during this turn */
  toolCalls: ToolCallSummary[];
  /** Aggregated tool usage: tool name → count */
  toolCounts: Record<string, number>;

  /** Files written or edited */
  filesChanged: string[];
  /** Files read */
  filesRead: string[];

  /** Git commit info */
  hasCommit: boolean;
  hasPush: boolean;
  hasPull: boolean;
  commitMessage: string | null;
  commitSha: string | null;

  /** Bash commands run */
  commands: string[];

  /** Error tracking */
  hasError: boolean;
  errorCount: number;
  hasCompaction: boolean;
  compactionText: string | null;

  /** Plan mode */
  hasPlanStart: boolean;
  hasPlanEnd: boolean;
  planMarkdown: string | null;
  planRejected: boolean;

  /** Task tracking */
  taskCreates: { taskId: string; subject: string; description: string }[];
  taskUpdates: { taskId: string; status: string }[];

  /** Token usage aggregated across all assistant events in this turn */
  tokenUsage: TokenUsage;
  /** Model used in this turn */
  model: string | null;
  /** Context window tokens for this turn's model (if available from provider telemetry). */
  contextWindowTokens: number | null;
  /** Duration of this turn in ms (from system metadata, if available) */
  durationMs: number | null;

  /** Raw events for this turn (for drill-down) */
  events: SessionEvent[];

  /** Position in the JSONL */
  startLine: number;
  endLine: number;
}

export interface ParsedSession {
  session: SessionInfo;
  turns: TurnNode[];
  /** Optional runtime hints for Codex sessions (unused for Claude). */
  codexRuntime?: {
    lastEventType: "turn_started" | "turn_complete" | "turn_aborted" | "shutdown" | null;
    lastEventAt: Date | null;
    inTurn: boolean;
    lastToolActivityAt: Date | null;
  };
  stats: {
    totalEvents: number;
    totalTurns: number;
    toolCalls: number;
    commits: number;
    compactions: number;
    filesChanged: string[];
    toolsUsed: Record<string, number>;
    totalTokenUsage: TokenUsage;
    errorTurns: number;
    correctionTurns: number;
    primaryModel: string | null;
  };
}

// ─── Checkpoint Types ───────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  sessionId: string;
  projectPath: string;
  note: string;
  timestamp: string;

  /** JSONL position — line count at checkpoint time */
  jsonlLineCount: number;

  /** Git state */
  gitCommitHash: string;
  gitBranch: string;
  gitDiff: string;

  /** Files modified since last checkpoint (or session start) */
  filesChanged: string[];

  /** If this checkpoint was rewound, the new session ID */
  rewindSessionId: string | null;
}

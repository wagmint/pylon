import { getDb } from "./db.js";

export type DerivedSessionStatus =
  | "blocked"
  | "stalled"
  | "completed"
  | "in_progress"
  | "idle";

export interface SessionStateRow {
  sessionId: string;
  derivedAt: string;
  status: DerivedSessionStatus;
  currentGoal: string;
  lastMeaningfulAction: string;
  resumeSummary: string;
  blockedReason: string | null;
  pendingApprovalCount: number;
  filesInPlayJson: string;
  lastTurnIndex: number | null;
  lastEventAt: string | null;
}

interface TurnStateRow {
  turnIndex: number;
  summary: string;
  userInstruction: string;
  hasCommit: number;
  commitMessage: string | null;
  hasError: number;
  errorCount: number;
  hasPlanEnd: number;
  planMarkdown: string | null;
  planRejected: number;
  startedAt: string;
}

interface PlanItemRow {
  turnIndex: number;
  source: string;
  taskId: string | null;
  subject: string;
  description: string | null;
  status: string | null;
}

interface FileTouchRow {
  turnIndex: number | null;
  filePath: string | null;
  action: string;
}

interface CommandRow {
  turnIndex: number | null;
  commandText: string;
  isGitCommit: number;
}

interface ApprovalRow {
  turnIndex: number;
  approvalType: string;
  status: string;
  detail: string | null;
}

interface ErrorRow {
  turnIndex: number | null;
  message: string;
}

export function deriveAndStoreSessionState(sessionId: string): SessionStateRow {
  const state = deriveSessionState(sessionId);
  const db = getDb();
  db.prepare(`
    INSERT INTO session_state(
      session_id,
      derived_at,
      status,
      current_goal,
      last_meaningful_action,
      resume_summary,
      blocked_reason,
      pending_approval_count,
      files_in_play_json,
      last_turn_index,
      last_event_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      derived_at = excluded.derived_at,
      status = excluded.status,
      current_goal = excluded.current_goal,
      last_meaningful_action = excluded.last_meaningful_action,
      resume_summary = excluded.resume_summary,
      blocked_reason = excluded.blocked_reason,
      pending_approval_count = excluded.pending_approval_count,
      files_in_play_json = excluded.files_in_play_json,
      last_turn_index = excluded.last_turn_index,
      last_event_at = excluded.last_event_at
  `).run(
    state.sessionId,
    state.derivedAt,
    state.status,
    state.currentGoal,
    state.lastMeaningfulAction,
    state.resumeSummary,
    state.blockedReason,
    state.pendingApprovalCount,
    state.filesInPlayJson,
    state.lastTurnIndex,
    state.lastEventAt,
  );
  return state;
}

export function listStoredSessionState(sessionId?: string): SessionStateRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      derived_at as derivedAt,
      status,
      current_goal as currentGoal,
      last_meaningful_action as lastMeaningfulAction,
      resume_summary as resumeSummary,
      blocked_reason as blockedReason,
      pending_approval_count as pendingApprovalCount,
      files_in_play_json as filesInPlayJson,
      last_turn_index as lastTurnIndex,
      last_event_at as lastEventAt
    FROM session_state
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY last_event_at DESC, session_id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as SessionStateRow[];
}

function deriveSessionState(sessionId: string): SessionStateRow {
  const db = getDb();
  const turns = db.prepare(`
    SELECT
      turn_index as turnIndex,
      summary,
      user_instruction as userInstruction,
      has_commit as hasCommit,
      commit_message as commitMessage,
      has_error as hasError,
      error_count as errorCount,
      has_plan_end as hasPlanEnd,
      plan_markdown as planMarkdown,
      plan_rejected as planRejected,
      started_at as startedAt
    FROM turns
    WHERE session_id = ?
    ORDER BY turn_index ASC
  `).all(sessionId) as TurnStateRow[];
  const latestTurn = turns.at(-1) ?? null;

  const planItems = db.prepare(`
    SELECT
      turn_index as turnIndex,
      source,
      task_id as taskId,
      subject,
      description,
      status
    FROM plan_items
    WHERE session_id = ?
    ORDER BY turn_index DESC, id DESC
  `).all(sessionId) as PlanItemRow[];
  const fileTouches = db.prepare(`
    SELECT
      turn_index as turnIndex,
      file_path as filePath,
      action
    FROM file_touches
    WHERE session_id = ?
    ORDER BY COALESCE(turn_index, -1) DESC, id DESC
  `).all(sessionId) as FileTouchRow[];
  const commands = db.prepare(`
    SELECT
      turn_index as turnIndex,
      command_text as commandText,
      is_git_commit as isGitCommit
    FROM commands
    WHERE session_id = ?
    ORDER BY COALESCE(turn_index, -1) DESC, id DESC
  `).all(sessionId) as CommandRow[];
  const approvals = db.prepare(`
    SELECT
      turn_index as turnIndex,
      approval_type as approvalType,
      status,
      detail
    FROM approvals
    WHERE session_id = ?
    ORDER BY turn_index DESC, id DESC
  `).all(sessionId) as ApprovalRow[];
  const errors = db.prepare(`
    SELECT
      turn_index as turnIndex,
      message
    FROM errors
    WHERE session_id = ?
    ORDER BY COALESCE(turn_index, -1) DESC, id DESC
  `).all(sessionId) as ErrorRow[];
  const lastEventRow = db.prepare(`
    SELECT last_event_at as lastEventAt
    FROM sessions
    WHERE id = ?
  `).get(sessionId) as { lastEventAt?: string | null } | undefined;

  const currentGoal = deriveCurrentGoal(planItems, latestTurn);
  const blockedReason = deriveBlockedReason(approvals, errors, latestTurn);
  const pendingApprovalCount = approvals.filter((approval) => approval.status === "pending").length;
  const filesInPlay = deriveFilesInPlay(fileTouches, latestTurn?.turnIndex ?? null);
  const lastMeaningfulAction = deriveLastMeaningfulAction(latestTurn, commands, filesInPlay);
  const status = deriveStatus({
    latestTurn,
    approvals,
    errors,
    currentGoal,
    lastMeaningfulAction,
    pendingApprovalCount,
  });
  const resumeSummary = buildResumeSummary({
    currentGoal,
    lastMeaningfulAction,
    blockedReason,
    filesInPlay,
  });

  return {
    sessionId,
    derivedAt: new Date().toISOString(),
    status,
    currentGoal,
    lastMeaningfulAction,
    resumeSummary,
    blockedReason,
    pendingApprovalCount,
    filesInPlayJson: JSON.stringify(filesInPlay),
    lastTurnIndex: latestTurn?.turnIndex ?? null,
    lastEventAt: lastEventRow?.lastEventAt ?? latestTurn?.startedAt ?? null,
  };
}

function deriveCurrentGoal(planItems: PlanItemRow[], latestTurn: TurnStateRow | null): string {
  const latestExplicit = planItems.find((item) =>
    item.subject.trim().length > 0
    && !(item.source === "task_update" && /^task\s+\d+$/i.test(item.subject.trim()))
    && item.status !== "completed"
    && item.status !== "done"
  );
  if (latestExplicit) return latestExplicit.subject.trim().slice(0, 240);

  const instruction = latestTurn?.userInstruction?.trim();
  if (instruction) return instruction.slice(0, 240);

  const summary = latestTurn?.summary?.trim();
  if (summary) return summary.slice(0, 240);

  return "No current goal inferred";
}

function deriveBlockedReason(
  approvals: ApprovalRow[],
  errors: ErrorRow[],
  latestTurn: TurnStateRow | null,
): string | null {
  const pendingApproval = approvals.find((approval) => approval.status === "pending");
  if (pendingApproval) {
    return pendingApproval.detail || `${pendingApproval.approvalType} approval pending`;
  }

  const rejectedApproval = approvals.find((approval) => approval.status === "rejected");
  if (rejectedApproval) {
    return rejectedApproval.detail || `${rejectedApproval.approvalType} approval rejected`;
  }

  if (latestTurn?.hasError && errors.length > 0) {
    return errors[0].message;
  }

  return null;
}

function deriveFilesInPlay(fileTouches: FileTouchRow[], latestTurnIndex: number | null): string[] {
  const ranked = new Map<string, number>();

  for (const touch of fileTouches) {
    if (!touch.filePath) continue;
    const recencyBonus = latestTurnIndex !== null && touch.turnIndex !== null
      ? Math.max(0, 10 - (latestTurnIndex - touch.turnIndex))
      : 0;
    const actionWeight = touch.action === "edit" || touch.action === "write"
      ? 3
      : touch.action === "read"
        ? 1
        : 0;
    const nextScore = (ranked.get(touch.filePath) ?? 0) + recencyBonus + actionWeight;
    ranked.set(touch.filePath, nextScore);
  }

  return [...ranked.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([filePath]) => filePath);
}

function deriveLastMeaningfulAction(
  latestTurn: TurnStateRow | null,
  commands: CommandRow[],
  filesInPlay: string[],
): string {
  if (!latestTurn) return "No recent action";

  if (latestTurn.hasCommit) {
    return latestTurn.commitMessage
      ? `Committed changes: ${latestTurn.commitMessage}`
      : "Committed changes";
  }

  const latestCommand = commands.find((command) => command.turnIndex === latestTurn.turnIndex);
  if (latestCommand) {
    return `Ran command: ${truncate(latestCommand.commandText, 120)}`;
  }

  if (filesInPlay.length > 0) {
    return filesInPlay.length === 1
      ? `Touched file: ${filesInPlay[0]}`
      : `Touched ${filesInPlay.length} files`;
  }

  if (latestTurn.hasPlanEnd && latestTurn.planMarkdown) {
    return "Approved plan";
  }

  return latestTurn.summary || "No recent action";
}

function deriveStatus(input: {
  latestTurn: TurnStateRow | null;
  approvals: ApprovalRow[];
  errors: ErrorRow[];
  currentGoal: string;
  lastMeaningfulAction: string;
  pendingApprovalCount: number;
}): DerivedSessionStatus {
  if (input.pendingApprovalCount > 0) return "blocked";
  if (input.approvals.some((approval) => approval.status === "rejected")) return "blocked";
  if (input.latestTurn?.hasError || input.errors.length > 0) return "stalled";
  if (input.latestTurn?.hasCommit) return "completed";
  if (input.currentGoal !== "No current goal inferred" || input.lastMeaningfulAction !== "No recent action") {
    return "in_progress";
  }
  return "idle";
}

function buildResumeSummary(input: {
  currentGoal: string;
  lastMeaningfulAction: string;
  blockedReason: string | null;
  filesInPlay: string[];
}): string {
  const parts = [
    `Goal: ${input.currentGoal}`,
    `Last action: ${input.lastMeaningfulAction}`,
  ];
  if (input.blockedReason) {
    parts.push(`Blocked on: ${input.blockedReason}`);
  }
  if (input.filesInPlay.length > 0) {
    parts.push(`Files in play: ${input.filesInPlay.slice(0, 4).join(", ")}`);
  }
  return parts.join(". ");
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

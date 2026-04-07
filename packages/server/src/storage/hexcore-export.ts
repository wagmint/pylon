import { getDb } from "./db.js";
import { STORAGE_PARSER_VERSION } from "./repositories.js";

export interface HexcoreExportSessionPayload {
  sessionId: string;
  sourceType: string | null;
  projectPath: string | null;
  cwd: string | null;
  gitBranch: string | null;
  sourceCreatedAt: string | null;
  sourceLastEventAt: string | null;
  sourceEndedAt: string | null;
  status: string;
  currentGoal: string;
  lastMeaningfulAction: string;
  blockedReason: string | null;
  pendingApprovalCount: number;
  errorCount: number;
  filesInPlay: string[];
  metadata: Record<string, unknown>;
  evidence: {
    messages: unknown[];
    planItems: unknown[];
    commands: unknown[];
    fileTouches: unknown[];
    approvals: unknown[];
    errors: unknown[];
  };
}

export interface HexcoreExportPayload {
  schemaVersion: string;
  checkpoint: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sessions: HexcoreExportSessionPayload[];
}

interface SessionRow {
  sessionId: string;
  sourceType: string | null;
  projectPath: string | null;
  cwd: string | null;
  gitBranch: string | null;
  sourceCreatedAt: string | null;
  sourceLastEventAt: string | null;
  sourceEndedAt: string | null;
  status: string | null;
  currentGoal: string | null;
  lastMeaningfulAction: string | null;
  blockedReason: string | null;
  pendingApprovalCount: number | null;
  filesInPlayJson: string | null;
  metadataJson: string | null;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function buildInClause(projectPaths: string[]): string {
  return projectPaths.map(() => "?").join(", ");
}

export function buildHexcoreExportPayload(projectPaths: string[]): HexcoreExportPayload {
  if (projectPaths.length === 0) {
    return {
      schemaVersion: "hexdeck-session-ingest-v1",
      checkpoint: {
        mode: "empty",
        parserVersion: STORAGE_PARSER_VERSION,
      },
      metadata: {
        parserVersion: STORAGE_PARSER_VERSION,
        projectCount: 0,
      },
      sessions: [],
    };
  }

  const db = getDb();
  const inClause = buildInClause(projectPaths);

  const sessions = db.prepare(`
    SELECT
      sessions.id as sessionId,
      sessions.source_type as sourceType,
      sessions.project_path as projectPath,
      sessions.cwd as cwd,
      sessions.git_branch as gitBranch,
      sessions.created_at as sourceCreatedAt,
      sessions.last_event_at as sourceLastEventAt,
      sessions.ended_at as sourceEndedAt,
      session_state.status as status,
      session_state.current_goal as currentGoal,
      session_state.last_meaningful_action as lastMeaningfulAction,
      session_state.blocked_reason as blockedReason,
      session_state.pending_approval_count as pendingApprovalCount,
      session_state.files_in_play_json as filesInPlayJson,
      sessions.metadata_json as metadataJson
    FROM sessions
    LEFT JOIN session_state ON session_state.session_id = sessions.id
    WHERE sessions.project_path IN (${inClause})
    ORDER BY sessions.last_event_at DESC
  `).all(...projectPaths) as SessionRow[];

  const messageStmt = db.prepare(`
    SELECT line_number as lineNumber, role, timestamp, text
    FROM messages
    WHERE session_id = ?
    ORDER BY line_number ASC
  `);
  const planItemStmt = db.prepare(`
    SELECT
      line_number as lineNumber,
      source,
      ordinal,
      task_id as taskId,
      subject,
      description,
      status,
      raw_text as rawText,
      timestamp
    FROM plan_items
    WHERE session_id = ?
    ORDER BY line_number ASC, ordinal ASC
  `);
  const commandStmt = db.prepare(`
    SELECT
      line_number as lineNumber,
      tool_call_id as toolCallId,
      command_text as commandText,
      is_git_commit as isGitCommit,
      is_git_push as isGitPush,
      is_git_pull as isGitPull,
      timestamp
    FROM commands
    WHERE session_id = ?
    ORDER BY line_number ASC
  `);
  const fileTouchStmt = db.prepare(`
    SELECT
      line_number as lineNumber,
      tool_call_id as toolCallId,
      file_path as filePath,
      module_key as moduleKey,
      action,
      source_tool as sourceTool,
      detail,
      timestamp
    FROM file_touches
    WHERE session_id = ?
    ORDER BY line_number ASC
  `);
  const approvalStmt = db.prepare(`
    SELECT
      line_number as lineNumber,
      approval_type as approvalType,
      status,
      detail,
      timestamp
    FROM approvals
    WHERE session_id = ?
    ORDER BY line_number ASC
  `);
  const errorStmt = db.prepare(`
    SELECT
      line_number as lineNumber,
      tool_use_id as toolUseId,
      tool_name as toolName,
      message,
      timestamp
    FROM errors
    WHERE session_id = ?
    ORDER BY line_number ASC
  `);

  let lastEventAtMax: string | null = null;
  const exportedSessions = sessions.map((session) => {
    const filesInPlay = parseJsonStringArray(session.filesInPlayJson);
    const metadata = parseJsonObject(session.metadataJson);
    const errors = errorStmt.all(session.sessionId);

    if (!lastEventAtMax || ((session.sourceLastEventAt ?? "") > lastEventAtMax)) {
      lastEventAtMax = session.sourceLastEventAt ?? lastEventAtMax;
    }

    return {
      sessionId: session.sessionId,
      sourceType: session.sourceType,
      projectPath: session.projectPath,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      sourceCreatedAt: session.sourceCreatedAt,
      sourceLastEventAt: session.sourceLastEventAt,
      sourceEndedAt: session.sourceEndedAt,
      status: session.status ?? "unknown",
      currentGoal: session.currentGoal ?? "",
      lastMeaningfulAction: session.lastMeaningfulAction ?? "",
      blockedReason: session.blockedReason,
      pendingApprovalCount: session.pendingApprovalCount ?? 0,
      errorCount: errors.length,
      filesInPlay,
      metadata,
      evidence: {
        messages: messageStmt.all(session.sessionId),
        planItems: planItemStmt.all(session.sessionId),
        commands: commandStmt.all(session.sessionId),
        fileTouches: fileTouchStmt.all(session.sessionId),
        approvals: approvalStmt.all(session.sessionId),
        errors,
      },
    };
  });

  return {
    schemaVersion: "hexdeck-session-ingest-v1",
    checkpoint: {
      mode: "full_project_export",
      parserVersion: STORAGE_PARSER_VERSION,
      projectPaths,
      sessionCount: exportedSessions.length,
      lastEventAtMax,
    },
    metadata: {
      parserVersion: STORAGE_PARSER_VERSION,
      projectCount: projectPaths.length,
    },
    sessions: exportedSessions,
  };
}

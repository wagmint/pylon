import crypto from "node:crypto";
import { existsSync, statSync } from "fs";
import { getDb } from "./db.js";
import { STORAGE_PARSER_VERSION } from "./repositories.js";
import { getCachedOrParse, getAccumulatorPlans } from "../core/session-cache.js";
import { buildCanonicalSessionPlans } from "../core/plans.js";
import { getSessionSummary, listSessionModelCosts } from "./session-summaries.js";
import type { SessionInfo, SessionPlan } from "../types/index.js";

export interface HexcoreSyncCursor {
  lastAcceptedSourceLastEventAt: string | null;
  lastAcceptedSessionId: string | null;
}

export interface ExportPlanTask {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface ExportPlan {
  /** Stable identity for this plan cycle (survives compaction/reparse) */
  planId: string;
  status: "drafting" | "implementing" | "completed" | "rejected";
  title: string;
  markdown: string | null;
  tasks: ExportPlanTask[];
  agentLabel: string;
  timestamp: string;
  progressPct: number;
  progressSummary: string;
  isFromActiveSession: boolean;
}

export interface ExportSessionSummary {
  totalTurns: number;
  totalCommits: number;
  totalErrors: number;
  totalCostUsd: number;
  errorRate: number;
  outcome: string;
  isDeadEnd: boolean;
  deadEndReason: string | null;
  durationMs: number | null;
  riskPeak: string;
  hadSpinning: boolean;
  filesChanged: string[];
  toolsUsed: Record<string, number>;
  plansCreated: number;
  plansCompleted: number;
  operatorId: string | null;
  operatorName: string | null;
  workstreamId: string | null;
}

export interface ExportModelCost {
  modelFamily: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface ExportTurnCost {
  turnIndex: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  occurredAt: string;
  rawModel: string;
  modelFamily: string;
}

export interface HexcoreExportSessionPayload {
  sessionId: string;
  contentHash: string;
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
    plans: ExportPlan[];
  };
  summary?: ExportSessionSummary;
  modelCosts?: ExportModelCost[];
  turnCosts?: ExportTurnCost[];
}

export interface HexcoreExportPayload {
  schemaVersion: string;
  checkpoint: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sessions: HexcoreExportSessionPayload[];
}

const BOOTSTRAP_LOOKBACK_HOURS = 24;

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
  transcriptFilePath: string | null;
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

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseJsonObject(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildInClause(projectPaths: string[]): string {
  return projectPaths.map(() => "?").join(", ");
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ─── Canonical plan serialization ───

function extractPlanTitle(plan: SessionPlan): string {
  if (plan.markdown) {
    const match = plan.markdown.match(/^#+\s+(.+)/m);
    if (match) {
      const heading = match[1].trim();
      return heading.length <= 80 ? heading : `${heading.slice(0, 77)}...`;
    }
  }
  const firstTask = plan.tasks.find((t) => t.subject.trim().length > 0);
  if (firstTask) {
    return firstTask.subject.length <= 80 ? firstTask.subject : `${firstTask.subject.slice(0, 77)}...`;
  }
  return "Untitled plan";
}

function serializeSessionPlan(plan: SessionPlan, sessionId: string): ExportPlan | null {
  // Skip "none" status plans
  if (plan.status === "none") return null;

  const title = extractPlanTitle(plan);
  const activeTasks = plan.tasks.filter((t) => t.status !== "deleted");
  const completed = activeTasks.filter((t) => t.status === "completed").length;

  // Stable identity: sessionId + plan start epoch ms (unique per cycle, survives reparse)
  const planId = `hexdeck-plan:${sessionId}:${plan.planStartedAt.getTime()}`;

  return {
    planId,
    status: plan.status as ExportPlan["status"],
    title,
    markdown: plan.markdown,
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      subject: t.subject,
      description: t.description,
      status: t.status,
    })),
    agentLabel: plan.agentLabel,
    timestamp: plan.timestamp.toISOString(),
    progressPct: activeTasks.length > 0 ? Math.round((completed / activeTasks.length) * 100) : 0,
    progressSummary: activeTasks.length > 0 ? `${completed} of ${activeTasks.length} tasks completed` : "",
    isFromActiveSession: plan.isFromActiveSession,
  };
}

function buildPlansForSession(
  sessionId: string,
  filePath: string | null,
  projectPath: string,
  sourceCreatedAt: string | null,
  sourceLastEventAt: string | null,
): ExportPlan[] {
  if (!filePath || !existsSync(filePath)) return [];

  let mtime: Date;
  let sizeBytes: number;
  try {
    const st = statSync(filePath);
    mtime = st.mtime;
    sizeBytes = st.size;
  } catch {
    return [];
  }

  const sessionInfo: SessionInfo = {
    id: sessionId,
    path: filePath,
    projectPath,
    createdAt: sourceCreatedAt ? new Date(sourceCreatedAt) : mtime,
    modifiedAt: sourceLastEventAt ? new Date(sourceLastEventAt) : mtime,
    sizeBytes,
  };

  let parsed;
  try {
    parsed = getCachedOrParse(sessionInfo);
  } catch {
    return [];
  }

  const priorPlans = getAccumulatorPlans(sessionId);
  const sessionPlans = buildCanonicalSessionPlans(parsed, "", false, priorPlans);

  const exported: ExportPlan[] = [];
  for (const plan of sessionPlans) {
    const ep = serializeSessionPlan(plan, sessionId);
    if (ep) exported.push(ep);
  }
  return exported;
}

function normalizeCursor(cursor?: HexcoreSyncCursor | null): HexcoreSyncCursor | null {
  if (!cursor) return null;
  return {
    lastAcceptedSourceLastEventAt: cursor.lastAcceptedSourceLastEventAt ?? null,
    lastAcceptedSessionId: cursor.lastAcceptedSessionId ?? null,
  };
}

export function buildHexcoreExportPayload(
  projectPaths: string[],
  options?: { cursor?: HexcoreSyncCursor | null },
): HexcoreExportPayload {
  const cursor = normalizeCursor(options?.cursor);
  if (projectPaths.length === 0) {
    return {
      schemaVersion: "hexdeck-session-ingest-v2",
      checkpoint: {
        mode: "empty",
        parserVersion: STORAGE_PARSER_VERSION,
        lowerBoundLastEventAt: cursor?.lastAcceptedSourceLastEventAt ?? null,
        lowerBoundSessionId: cursor?.lastAcceptedSessionId ?? null,
        upperBoundLastEventAt: cursor?.lastAcceptedSourceLastEventAt ?? null,
        upperBoundSessionId: cursor?.lastAcceptedSessionId ?? null,
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
  const params: unknown[] = [...projectPaths];
  let cursorWhere = "";
  if (cursor?.lastAcceptedSourceLastEventAt) {
    params.push(cursor.lastAcceptedSourceLastEventAt, cursor.lastAcceptedSourceLastEventAt, cursor.lastAcceptedSessionId ?? "");
    cursorWhere = `
      AND (
        sessions.last_event_at > ?
        OR (sessions.last_event_at = ? AND sessions.id > ?)
      )
    `;
  } else {
    params.push(`-${BOOTSTRAP_LOOKBACK_HOURS} hours`);
    cursorWhere = `
      AND sessions.last_event_at >= datetime('now', ?)
    `;
  }

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
      sessions.metadata_json as metadataJson,
      transcript_sources.file_path as transcriptFilePath
    FROM sessions
    LEFT JOIN session_state ON session_state.session_id = sessions.id
    LEFT JOIN transcript_sources ON transcript_sources.id = sessions.transcript_source_id
    WHERE sessions.project_path IN (${inClause})
    ${cursorWhere}
    ORDER BY sessions.last_event_at ASC, sessions.id ASC
  `).all(...params) as SessionRow[];

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

  const turnCostStmt = db.prepare(`
    SELECT
      turn_index as turnIndex,
      cost_usd as costUsd,
      input_tokens as inputTokens,
      output_tokens as outputTokens,
      cache_read_input_tokens as cacheReadTokens,
      cache_creation_input_tokens as cacheWriteTokens,
      started_at as occurredAt,
      COALESCE(model, model_family, 'unknown') as rawModel,
      COALESCE(model_family, model, 'unknown') as modelFamily
    FROM turns
    WHERE session_id = ? AND cost_usd > 0
    ORDER BY turn_index ASC
  `);

  let lastEventAtMax: string | null = null;
  let lastSessionIdMax: string | null = null;
  const exportedSessions = sessions.map((session) => {
    const filesInPlay = parseJsonStringArray(session.filesInPlayJson);
    const metadata = parseJsonObject(session.metadataJson);
    const errors = errorStmt.all(session.sessionId);
    const planItems = planItemStmt.all(session.sessionId);

    // Build plans from canonical JSONL parser (faithful to dashboard)
    const plans = buildPlansForSession(
      session.sessionId,
      session.transcriptFilePath,
      session.projectPath ?? "",
      session.sourceCreatedAt,
      session.sourceLastEventAt,
    );

    const evidence = {
      messages: messageStmt.all(session.sessionId),
      planItems,
      commands: commandStmt.all(session.sessionId),
      fileTouches: fileTouchStmt.all(session.sessionId),
      approvals: approvalStmt.all(session.sessionId),
      errors,
      plans,
    };

    if (
      session.sourceLastEventAt
      && (
        !lastEventAtMax
        || session.sourceLastEventAt > lastEventAtMax
        || (session.sourceLastEventAt === lastEventAtMax && session.sessionId > (lastSessionIdMax ?? ""))
      )
    ) {
      lastEventAtMax = session.sourceLastEventAt;
      lastSessionIdMax = session.sessionId;
    }

    // Build v2 summary/cost fields
    const summaryRow = getSessionSummary(session.sessionId);
    let v2Fields: {
      summary?: ExportSessionSummary;
      modelCosts?: ExportModelCost[];
      turnCosts?: ExportTurnCost[];
    } = {};

    if (summaryRow) {
      const filesChanged: string[] = summaryRow.filesChanged
        ? safeParseJsonArray(summaryRow.filesChanged)
        : [];
      const toolsUsed: Record<string, number> = summaryRow.toolsUsed
        ? safeParseJsonObject(summaryRow.toolsUsed)
        : {};

      v2Fields.summary = {
        totalTurns: summaryRow.totalTurns,
        totalCommits: summaryRow.totalCommits,
        totalErrors: summaryRow.totalErrors,
        totalCostUsd: summaryRow.totalCostUsd,
        errorRate: summaryRow.errorRate,
        outcome: summaryRow.outcome,
        isDeadEnd: summaryRow.isDeadEnd === 1,
        deadEndReason: summaryRow.deadEndReason,
        durationMs: summaryRow.durationMs,
        riskPeak: summaryRow.riskPeak,
        hadSpinning: summaryRow.hadSpinning === 1,
        filesChanged,
        toolsUsed,
        plansCreated: summaryRow.plansCreated,
        plansCompleted: summaryRow.plansCompleted,
        operatorId: summaryRow.operatorId,
        operatorName: summaryRow.operatorName,
        workstreamId: summaryRow.workstreamId,
      };

      // modelCosts are summary-derived, so keep them gated by summaryRow
      v2Fields.modelCosts = listSessionModelCosts(session.sessionId).map((mc) => ({
        modelFamily: mc.modelFamily,
        turnCount: mc.turnCount,
        inputTokens: mc.inputTokens,
        outputTokens: mc.outputTokens,
        cacheReadTokens: mc.cacheReadTokens,
        cacheCreationTokens: mc.cacheCreationTokens,
        costUsd: mc.costUsd,
      }));
    }

    // turnCosts come directly from turns table — export whenever priced turns exist,
    // even for active sessions that don't have a materialized summary yet
    const turnCostRows = turnCostStmt.all(session.sessionId) as Array<{
      turnIndex: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      occurredAt: string;
      rawModel: string;
      modelFamily: string;
    }>;
    // Always include turnCosts — even an empty array signals "no costed turns"
    // so Hexcore can clear stale rows from a prior ingest
    v2Fields.turnCosts = turnCostRows.map((tc) => ({
      turnIndex: tc.turnIndex,
      costUsd: tc.costUsd,
      inputTokens: tc.inputTokens,
      outputTokens: tc.outputTokens,
      cacheReadTokens: tc.cacheReadTokens,
      cacheWriteTokens: tc.cacheWriteTokens,
      occurredAt: tc.occurredAt,
      rawModel: tc.rawModel,
      modelFamily: tc.modelFamily,
    }));

    const payloadWithoutHash = {
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
      evidence,
      ...v2Fields,
    };

    return {
      ...payloadWithoutHash,
      contentHash: stableHash(payloadWithoutHash),
    };
  });

  return {
    schemaVersion: "hexdeck-session-ingest-v2",
    checkpoint: {
      mode: cursor ? "incremental_project_export" : "bootstrap_recent_24h",
      parserVersion: STORAGE_PARSER_VERSION,
      projectPaths,
      sessionCount: exportedSessions.length,
      lowerBoundLastEventAt: cursor?.lastAcceptedSourceLastEventAt ?? null,
      lowerBoundSessionId: cursor?.lastAcceptedSessionId ?? null,
      upperBoundLastEventAt: lastEventAtMax ?? cursor?.lastAcceptedSourceLastEventAt ?? null,
      upperBoundSessionId: lastSessionIdMax ?? cursor?.lastAcceptedSessionId ?? null,
      bootstrapLookbackHours: cursor ? null : BOOTSTRAP_LOOKBACK_HOURS,
    },
    metadata: {
      parserVersion: STORAGE_PARSER_VERSION,
      projectCount: projectPaths.length,
      bootstrapLookbackHours: cursor ? null : BOOTSTRAP_LOOKBACK_HOURS,
    },
    sessions: exportedSessions,
  };
}

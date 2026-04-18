import { getDb, withTransaction } from "./db.js";
import { detectSpinningFromStoredEvidence } from "../core/risk.js";
import { loadOperatorConfig, getSelfName, operatorId } from "../core/config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionSummaryRow {
  sessionId: string;
  provider: string;
  operatorId: string | null;
  operatorName: string | null;
  projectPath: string;
  gitBranch: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  isPartial: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalCommits: number;
  totalErrors: number;
  totalCompactions: number;
  errorRate: number;
  riskPeak: string;
  hadSpinning: number;
  spinningTypes: string | null;
  plansCreated: number;
  plansCompleted: number;
  outcome: string;
  isDeadEnd: number;
  deadEndReason: string | null;
  workstreamId: string | null;
  filesChanged: string | null;
  toolsUsed: string | null;
  summarizedAt: string;
}

export interface SessionModelCostRow {
  sessionId: string;
  modelFamily: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

// ─── Internal row types ─────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  sourceType: string;
  projectPath: string;
  gitBranch: string | null;
  createdAt: string;
  endedAt: string | null;
}

interface TurnAggregateRow {
  turnCount: number;
  minStartedAt: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalErrors: number;
  totalCompactions: number;
}

interface ModelCostAggregateRow {
  modelFamily: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

// ─── Materializer ───────────────────────────────────────────────────────────

export function materializeSessionSummary(sessionId: string): SessionSummaryRow | null {
  const db = getDb();

  // 1. Load session row
  const session = db.prepare(`
    SELECT
      id,
      source_type as sourceType,
      project_path as projectPath,
      git_branch as gitBranch,
      created_at as createdAt,
      ended_at as endedAt
    FROM sessions
    WHERE id = ?
  `).get(sessionId) as SessionRow | undefined;

  if (!session) return null;

  // 2. Aggregate from turns (including MIN(started_at) for true session start)
  const turnAgg = db.prepare(`
    SELECT
      COUNT(*) as turnCount,
      MIN(started_at) as minStartedAt,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COALESCE(SUM(cache_read_input_tokens), 0) as totalCacheReadTokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) as totalCacheCreationTokens,
      COALESCE(SUM(COALESCE(cost_usd, 0)), 0) as totalCostUsd,
      COALESCE(SUM(error_count), 0) as totalErrors,
      COALESCE(SUM(has_compaction), 0) as totalCompactions
    FROM turns
    WHERE session_id = ?
  `).get(sessionId) as TurnAggregateRow;

  // 3. Count commits
  const commitRow = db.prepare(`
    SELECT COUNT(*) as count FROM commits WHERE session_id = ?
  `).get(sessionId) as { count: number };

  // 4. Compute derived fields
  // Use first turn timestamp when available, fall back to session created_at
  const startedAt = turnAgg.minStartedAt ?? session.createdAt;
  const endedAt = session.endedAt;
  let durationMs: number | null = null;
  if (endedAt) {
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(endedAt).getTime();
    durationMs = endMs - startMs;
  }

  const isPartial = endedAt ? 0 : 1;
  const errorRate = turnAgg.turnCount > 0 ? turnAgg.totalErrors / turnAgg.turnCount : 0;
  const summarizedAt = new Date().toISOString();

  const summary: SessionSummaryRow = {
    sessionId,
    provider: session.sourceType,
    operatorId: null,
    operatorName: null,
    projectPath: session.projectPath,
    gitBranch: session.gitBranch,
    startedAt,
    endedAt,
    durationMs,
    isPartial,
    totalTurns: turnAgg.turnCount,
    totalInputTokens: turnAgg.totalInputTokens,
    totalOutputTokens: turnAgg.totalOutputTokens,
    totalCacheReadTokens: turnAgg.totalCacheReadTokens,
    totalCacheCreationTokens: turnAgg.totalCacheCreationTokens,
    totalCostUsd: turnAgg.totalCostUsd,
    totalCommits: commitRow.count,
    totalErrors: turnAgg.totalErrors,
    totalCompactions: turnAgg.totalCompactions,
    errorRate,
    // Enrichment defaults — populated by PR 3b
    riskPeak: "nominal",
    hadSpinning: 0,
    spinningTypes: null,
    plansCreated: 0,
    plansCompleted: 0,
    outcome: "unknown",
    isDeadEnd: 0,
    deadEndReason: null,
    workstreamId: null,
    filesChanged: null,
    toolsUsed: null,
    summarizedAt,
  };

  // 5. Get model cost breakdown
  const modelCosts = db.prepare(`
    SELECT
      model_family as modelFamily,
      COUNT(*) as turnCount,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_read_input_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) as cacheCreationTokens,
      COALESCE(SUM(COALESCE(cost_usd, 0)), 0) as costUsd
    FROM turns
    WHERE session_id = ? AND model_family IS NOT NULL
    GROUP BY model_family
  `).all(sessionId) as ModelCostAggregateRow[];

  // 6. Write everything in a transaction
  withTransaction(() => {
    // Upsert session_summaries
    db.prepare(`
      INSERT INTO session_summaries(
        session_id, provider, operator_id, operator_name,
        project_path, git_branch, started_at, ended_at,
        duration_ms, is_partial,
        total_turns, total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_creation_tokens,
        total_cost_usd, total_commits, total_errors, total_compactions,
        error_rate, risk_peak, had_spinning, spinning_types,
        plans_created, plans_completed,
        outcome, is_dead_end, dead_end_reason,
        workstream_id, files_changed, tools_used, summarized_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        operator_id = excluded.operator_id,
        operator_name = excluded.operator_name,
        project_path = excluded.project_path,
        git_branch = excluded.git_branch,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms,
        is_partial = excluded.is_partial,
        total_turns = excluded.total_turns,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cache_read_tokens = excluded.total_cache_read_tokens,
        total_cache_creation_tokens = excluded.total_cache_creation_tokens,
        total_cost_usd = excluded.total_cost_usd,
        total_commits = excluded.total_commits,
        total_errors = excluded.total_errors,
        total_compactions = excluded.total_compactions,
        error_rate = excluded.error_rate,
        risk_peak = excluded.risk_peak,
        had_spinning = excluded.had_spinning,
        spinning_types = excluded.spinning_types,
        plans_created = excluded.plans_created,
        plans_completed = excluded.plans_completed,
        outcome = excluded.outcome,
        is_dead_end = excluded.is_dead_end,
        dead_end_reason = excluded.dead_end_reason,
        workstream_id = excluded.workstream_id,
        files_changed = excluded.files_changed,
        tools_used = excluded.tools_used,
        summarized_at = excluded.summarized_at
    `).run(
      summary.sessionId,
      summary.provider,
      summary.operatorId,
      summary.operatorName,
      summary.projectPath,
      summary.gitBranch,
      summary.startedAt,
      summary.endedAt,
      summary.durationMs,
      summary.isPartial,
      summary.totalTurns,
      summary.totalInputTokens,
      summary.totalOutputTokens,
      summary.totalCacheReadTokens,
      summary.totalCacheCreationTokens,
      summary.totalCostUsd,
      summary.totalCommits,
      summary.totalErrors,
      summary.totalCompactions,
      summary.errorRate,
      summary.riskPeak,
      summary.hadSpinning,
      summary.spinningTypes,
      summary.plansCreated,
      summary.plansCompleted,
      summary.outcome,
      summary.isDeadEnd,
      summary.deadEndReason,
      summary.workstreamId,
      summary.filesChanged,
      summary.toolsUsed,
      summary.summarizedAt,
    );

    // Delete + re-insert model costs
    db.prepare(`DELETE FROM session_model_costs WHERE session_id = ?`).run(sessionId);

    if (modelCosts.length > 0) {
      const insertCost = db.prepare(`
        INSERT INTO session_model_costs(
          session_id, model_family, turn_count,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const mc of modelCosts) {
        insertCost.run(
          sessionId,
          mc.modelFamily,
          mc.turnCount,
          mc.inputTokens,
          mc.outputTokens,
          mc.cacheReadTokens,
          mc.cacheCreationTokens,
          mc.costUsd,
        );
      }
    }
  });

  return summary;
}

export function materializePendingSummaries(): number {
  const db = getDb();

  // Find sessions with status='ended' that don't have a non-partial summary yet
  const pending = db.prepare(`
    SELECT s.id
    FROM sessions s
    WHERE s.status = 'ended'
      AND NOT EXISTS (
        SELECT 1 FROM session_summaries ss
        WHERE ss.session_id = s.id AND ss.is_partial = 0
      )
  `).all() as Array<{ id: string }>;

  let count = 0;
  for (const row of pending) {
    const result = materializeSessionSummary(row.id);
    if (result) count++;
  }

  return count;
}

// ─── Enrichment ─────────────────────────────────────────────────────────────

export function enrichSessionSummary(sessionId: string): void {
  const db = getDb();

  // 1. tools_used — tool_name → count
  const toolRows = db.prepare(`
    SELECT tool_name as toolName, COUNT(*) as count
    FROM tool_calls WHERE session_id = ?
    GROUP BY tool_name
  `).all(sessionId) as Array<{ toolName: string; count: number }>;

  const toolsUsed: Record<string, number> = {};
  for (const row of toolRows) {
    toolsUsed[row.toolName] = row.count;
  }

  // 2. files_changed — distinct file paths with write/edit actions
  const fileRows = db.prepare(`
    SELECT DISTINCT file_path as filePath
    FROM file_touches
    WHERE session_id = ? AND action IN ('write', 'edit')
  `).all(sessionId) as Array<{ filePath: string }>;

  const filesChanged = fileRows.map(r => r.filePath).filter(Boolean);

  // 3. plans_created / plans_completed from plan_items
  //    plans_created: count of plan_markdown rows (actual plan drafting events)
  //    plans_completed: count of plans where ALL associated tasks are completed.
  //    Tasks belong to a plan if created between that plan's turn_index and the
  //    next plan's turn_index. A plan with 0 tasks is not counted as completed.
  //    NOTE: this grouping is heuristic — plan_items has no explicit plan/group id,
  //    so we associate task_create rows to the nearest preceding plan_markdown by
  //    turn_index. If a future schema adds a plan_group_id, prefer that instead.
  const plansCreatedRow = db.prepare(`
    SELECT COUNT(*) as count FROM plan_items
    WHERE session_id = ? AND source = 'plan_markdown'
  `).get(sessionId) as { count: number };
  const plansCreated = plansCreatedRow.count;

  let plansCompleted = 0;
  if (plansCreated > 0) {
    const planTurnRows = db.prepare(`
      SELECT turn_index as turnIndex FROM plan_items
      WHERE session_id = ? AND source = 'plan_markdown'
      ORDER BY turn_index
    `).all(sessionId) as Array<{ turnIndex: number }>;

    const taskCreateRows = db.prepare(`
      SELECT task_id as taskId, turn_index as turnIndex FROM plan_items
      WHERE session_id = ? AND source = 'task_create' AND task_id IS NOT NULL
    `).all(sessionId) as Array<{ taskId: string; turnIndex: number }>;

    const completedTaskIds = new Set(
      (db.prepare(`
        SELECT DISTINCT task_id as taskId FROM plan_items
        WHERE session_id = ? AND source = 'task_update'
          AND status IN ('completed', 'done') AND task_id IS NOT NULL
      `).all(sessionId) as Array<{ taskId: string }>).map(r => r.taskId),
    );

    for (let i = 0; i < planTurnRows.length; i++) {
      const planTurn = planTurnRows[i].turnIndex;
      const nextPlanTurn = i + 1 < planTurnRows.length
        ? planTurnRows[i + 1].turnIndex
        : Infinity;

      const planTasks = taskCreateRows.filter(
        tc => tc.turnIndex >= planTurn && tc.turnIndex < nextPlanTurn,
      );

      if (planTasks.length > 0 && planTasks.every(tc => completedTaskIds.has(tc.taskId))) {
        plansCompleted++;
      }
    }
  }

  // 4. risk_peak / had_spinning / spinning_types
  const turnRows = db.prepare(`
    SELECT has_error as hasError, turn_index as turnIndex
    FROM turns WHERE session_id = ?
  `).all(sessionId) as Array<{ hasError: number; turnIndex: number }>;

  const fileTouchRows = db.prepare(`
    SELECT file_path as filePath, action, turn_index as turnIndex
    FROM file_touches WHERE session_id = ?
  `).all(sessionId) as Array<{ filePath: string; action: string; turnIndex: number }>;

  const commandRows = db.prepare(`
    SELECT command_text as commandText, turn_index as turnIndex
    FROM commands WHERE session_id = ?
  `).all(sessionId) as Array<{ commandText: string; turnIndex: number }>;

  const errorRows = db.prepare(`
    SELECT tool_name as toolName, message, turn_index as turnIndex
    FROM errors WHERE session_id = ?
  `).all(sessionId) as Array<{ toolName: string; message: string; turnIndex: number }>;

  const riskResult = detectSpinningFromStoredEvidence({
    turns: turnRows,
    fileTouches: fileTouchRows,
    commands: commandRows,
    errors: errorRows,
  });

  // 5. operator_id / operator_name
  let resolvedOperatorId: string | null = null;
  let resolvedOperatorName: string | null = null;

  try {
    const config = loadOperatorConfig();
    const selfName = getSelfName(config);

    // Get transcript source path for this session
    const tsRow = db.prepare(`
      SELECT t.file_path as filePath
      FROM transcript_sources t
      JOIN sessions s ON s.transcript_source_id = t.id
      WHERE s.id = ?
    `).get(sessionId) as { filePath: string } | undefined;

    const filePath = tsRow?.filePath ?? "";
    let matched = false;

    for (const op of config.operators) {
      if (op.claude && isUnderPath(filePath, op.claude)) {
        resolvedOperatorId = operatorId(op.name);
        resolvedOperatorName = op.name;
        matched = true;
        break;
      }
      if (op.codex && isUnderPath(filePath, op.codex)) {
        resolvedOperatorId = operatorId(op.name);
        resolvedOperatorName = op.name;
        matched = true;
        break;
      }
    }

    if (!matched) {
      resolvedOperatorId = "self";
      resolvedOperatorName = selfName;
    }
  } catch {
    resolvedOperatorId = "self";
    resolvedOperatorName = "self";
  }

  // 6. workstream_id
  const wsRow = db.prepare(`
    SELECT workstream_id as workstreamId
    FROM workstream_sessions
    WHERE session_id = ?
    ORDER BY confidence DESC
    LIMIT 1
  `).get(sessionId) as { workstreamId: string } | undefined;

  const workstreamId = wsRow?.workstreamId ?? null;

  // 7. UPDATE the existing row
  db.prepare(`
    UPDATE session_summaries SET
      tools_used = ?,
      files_changed = ?,
      plans_created = ?,
      plans_completed = ?,
      risk_peak = ?,
      had_spinning = ?,
      spinning_types = ?,
      operator_id = ?,
      operator_name = ?,
      workstream_id = ?
    WHERE session_id = ?
  `).run(
    JSON.stringify(toolsUsed),
    JSON.stringify(filesChanged),
    plansCreated,
    plansCompleted,
    riskResult.riskPeak,
    riskResult.hadSpinning ? 1 : 0,
    riskResult.spinningTypes.length > 0 ? JSON.stringify(riskResult.spinningTypes) : null,
    resolvedOperatorId,
    resolvedOperatorName,
    workstreamId,
    sessionId,
  );
}

export function enrichPendingSummaries(): number {
  const db = getDb();

  const pending = db.prepare(`
    SELECT session_id as sessionId
    FROM session_summaries
    WHERE tools_used IS NULL
  `).all() as Array<{ sessionId: string }>;

  let count = 0;
  for (const row of pending) {
    enrichSessionSummary(row.sessionId);
    count++;
  }

  return count;
}

// ─── Queries ────────────────────────────────────────────────────────────────

export function getSessionSummary(sessionId: string): SessionSummaryRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      session_id as sessionId,
      provider,
      operator_id as operatorId,
      operator_name as operatorName,
      project_path as projectPath,
      git_branch as gitBranch,
      started_at as startedAt,
      ended_at as endedAt,
      duration_ms as durationMs,
      is_partial as isPartial,
      total_turns as totalTurns,
      total_input_tokens as totalInputTokens,
      total_output_tokens as totalOutputTokens,
      total_cache_read_tokens as totalCacheReadTokens,
      total_cache_creation_tokens as totalCacheCreationTokens,
      total_cost_usd as totalCostUsd,
      total_commits as totalCommits,
      total_errors as totalErrors,
      total_compactions as totalCompactions,
      error_rate as errorRate,
      risk_peak as riskPeak,
      had_spinning as hadSpinning,
      spinning_types as spinningTypes,
      plans_created as plansCreated,
      plans_completed as plansCompleted,
      outcome,
      is_dead_end as isDeadEnd,
      dead_end_reason as deadEndReason,
      workstream_id as workstreamId,
      files_changed as filesChanged,
      tools_used as toolsUsed,
      summarized_at as summarizedAt
    FROM session_summaries
    WHERE session_id = ?
  `).get(sessionId) as SessionSummaryRow | undefined;

  return row ?? null;
}

export function listSessionModelCosts(sessionId: string): SessionModelCostRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      session_id as sessionId,
      model_family as modelFamily,
      turn_count as turnCount,
      input_tokens as inputTokens,
      output_tokens as outputTokens,
      cache_read_tokens as cacheReadTokens,
      cache_creation_tokens as cacheCreationTokens,
      cost_usd as costUsd
    FROM session_model_costs
    WHERE session_id = ?
    ORDER BY cost_usd DESC
  `).all(sessionId) as SessionModelCostRow[];
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Path-aware containment check: does filePath reside under dirPath? */
function isUnderPath(filePath: string, dirPath: string): boolean {
  const dir = dirPath.endsWith("/") ? dirPath : dirPath + "/";
  return filePath === dirPath || filePath.startsWith(dir);
}

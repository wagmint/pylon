import { getDb } from "../storage/db.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AnalyticsState {
  generatedAt: string;

  fileHeatmap: {
    modules: Array<{
      moduleKey: string;
      touchCount: number;
      writeCount: number;
      readCount: number;
      sessionCount: number;
    }>;
    topFiles: Array<{
      filePath: string;
      moduleKey: string | null;
      writes: number;
      reads: number;
      total: number;
      sessionCount: number;
    }>;
  };

  cost: {
    totals: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      totalCostUsd: number;
      turns: number;
      sessions: number;
    };
    byWorkstream: Array<{
      workstreamTitle: string;
      turns: number;
      sessions: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
    }>;
  };

  activity: {
    daily: Array<{
      day: string;
      turns: number;
      sessions: number;
      outputTokens: number;
    }>;
    recentCommits: Array<{
      message: string | null;
      sha: string | null;
      timestamp: string | null;
      sessionId: string;
    }>;
    recentDecisions: Array<{
      title: string;
      status: string;
      summary: string | null;
      decidedAt: string | null;
    }>;
  };
}

// ─── Query helpers ──────────────────────────────────────────────────────────

function queryFileHeatmapModules(db: ReturnType<typeof getDb>) {
  const rows = db
    .prepare(
      `SELECT
         module_key,
         COUNT(*) AS touch_count,
         SUM(CASE WHEN action IN ('write', 'create', 'edit') THEN 1 ELSE 0 END) AS write_count,
         SUM(CASE WHEN action = 'read' THEN 1 ELSE 0 END) AS read_count,
         COUNT(DISTINCT session_id) AS session_count
       FROM file_touches
       WHERE module_key IS NOT NULL
       GROUP BY module_key
       ORDER BY touch_count DESC`,
    )
    .all() as Array<{
    module_key: string;
    touch_count: number;
    write_count: number;
    read_count: number;
    session_count: number;
  }>;

  return rows.map((r) => ({
    moduleKey: r.module_key,
    touchCount: r.touch_count,
    writeCount: r.write_count,
    readCount: r.read_count,
    sessionCount: r.session_count,
  }));
}

function queryFileHeatmapTopFiles(db: ReturnType<typeof getDb>) {
  const rows = db
    .prepare(
      `SELECT
         file_path,
         module_key,
         SUM(CASE WHEN action IN ('write', 'create', 'edit') THEN 1 ELSE 0 END) AS writes,
         SUM(CASE WHEN action = 'read' THEN 1 ELSE 0 END) AS reads,
         COUNT(*) AS total,
         COUNT(DISTINCT session_id) AS session_count
       FROM file_touches
       WHERE file_path IS NOT NULL
       GROUP BY file_path
       ORDER BY writes DESC, total DESC
       LIMIT 30`,
    )
    .all() as Array<{
    file_path: string;
    module_key: string | null;
    writes: number;
    reads: number;
    total: number;
    session_count: number;
  }>;

  return rows.map((r) => ({
    filePath: r.file_path,
    moduleKey: r.module_key,
    writes: r.writes,
    reads: r.reads,
    total: r.total,
    sessionCount: r.session_count,
  }));
}

function queryCostTotals(db: ReturnType<typeof getDb>) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         COUNT(*) AS turns,
         COUNT(DISTINCT session_id) AS sessions
       FROM turns`,
    )
    .get() as {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    total_cost_usd: number;
    turns: number;
    sessions: number;
  };

  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    totalCostUsd: row.total_cost_usd,
    turns: row.turns,
    sessions: row.sessions,
  };
}

function queryCostByWorkstream(db: ReturnType<typeof getDb>) {
  const rows = db
    .prepare(
      `SELECT
         w.title AS workstream_title,
         COUNT(t.id) AS turns,
         COUNT(DISTINCT t.session_id) AS sessions,
         COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
         COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(t.cache_read_input_tokens), 0) AS cache_read_tokens
       FROM workstreams w
       JOIN workstream_sessions ws ON ws.workstream_id = w.id
       JOIN turns t ON t.session_id = ws.session_id
       GROUP BY w.id
       ORDER BY output_tokens DESC`,
    )
    .all() as Array<{
    workstream_title: string;
    turns: number;
    sessions: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
  }>;

  return rows.map((r) => ({
    workstreamTitle: r.workstream_title,
    turns: r.turns,
    sessions: r.sessions,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
  }));
}

function queryActivityDaily(db: ReturnType<typeof getDb>) {
  const rows = db
    .prepare(
      `SELECT
         date(started_at) AS day,
         COUNT(*) AS turns,
         COUNT(DISTINCT session_id) AS sessions,
         COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM turns
       WHERE started_at >= date('now', '-30 days')
       GROUP BY date(started_at)
       ORDER BY day ASC`,
    )
    .all() as Array<{
    day: string;
    turns: number;
    sessions: number;
    output_tokens: number;
  }>;

  return rows.map((r) => ({
    day: r.day,
    turns: r.turns,
    sessions: r.sessions,
    outputTokens: r.output_tokens,
  }));
}

function queryRecentCommits(db: ReturnType<typeof getDb>) {
  const rows = db
    .prepare(
      `SELECT
         commit_message,
         commit_sha,
         timestamp,
         session_id
       FROM commits
       ORDER BY timestamp DESC
       LIMIT 15`,
    )
    .all() as Array<{
    commit_message: string | null;
    commit_sha: string | null;
    timestamp: string | null;
    session_id: string;
  }>;

  return rows.map((r) => ({
    message: r.commit_message,
    sha: r.commit_sha,
    timestamp: r.timestamp,
    sessionId: r.session_id,
  }));
}

function queryRecentDecisions(db: ReturnType<typeof getDb>) {
  const rows = db
    .prepare(
      `SELECT
         title,
         status,
         summary,
         decided_at
       FROM decisions
       WHERE status = 'approved'
       ORDER BY decided_at DESC
       LIMIT 15`,
    )
    .all() as Array<{
    title: string;
    status: string;
    summary: string | null;
    decided_at: string | null;
  }>;

  return rows.map((r) => ({
    title: r.title,
    status: r.status,
    summary: r.summary,
    decidedAt: r.decided_at,
  }));
}

// ─── Main builder ───────────────────────────────────────────────────────────

export function buildAnalyticsState(): AnalyticsState {
  const db = getDb();

  return {
    generatedAt: new Date().toISOString(),

    fileHeatmap: {
      modules: queryFileHeatmapModules(db),
      topFiles: queryFileHeatmapTopFiles(db),
    },

    cost: {
      totals: queryCostTotals(db),
      byWorkstream: queryCostByWorkstream(db),
    },

    activity: {
      daily: queryActivityDaily(db),
      recentCommits: queryRecentCommits(db),
      recentDecisions: queryRecentDecisions(db),
    },
  };
}

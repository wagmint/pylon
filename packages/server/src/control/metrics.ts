import { getDb } from "../storage/db.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SpendDimension = "operator" | "project" | "model" | "outcome";
export type TrendMetric = "cost" | "error_rate" | "turns" | "sessions" | "dead_end_rate";
export type TrendGranularity = "day" | "week";

export interface SpendParams {
  by: SpendDimension;
  from?: string;       // ISO date string
  to?: string;         // ISO date string
  operator?: string;   // filter by operator_id
  project?: string;    // filter by project_path
}

export interface SpendBucket {
  key: string;
  costUsd: number;
  sessions: number;
  turns: number;
}

export interface SpendResult {
  dimension: string;
  buckets: SpendBucket[];
}

export interface TrendParams {
  metric: TrendMetric;
  granularity: TrendGranularity;
  days: number;
  operator?: string;
  project?: string;
}

export interface TrendPoint {
  bucketStart: string;
  value: number;
}

export interface TrendResult {
  metric: string;
  granularity: string;
  points: TrendPoint[];
}

export interface SessionListParams {
  from?: string;
  to?: string;
  outcome?: string;
  operator?: string;
  project?: string;
  limit: number;
  offset: number;
}

export interface SessionListItem {
  sessionId: string;
  provider: string;
  operatorId: string | null;
  operatorName: string | null;
  projectPath: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  totalCostUsd: number;
  totalTurns: number;
  totalCommits: number;
  outcome: string;
  isDeadEnd: boolean;
}

export interface SessionListResult {
  sessions: SessionListItem[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const VALID_DIMENSIONS = new Set<SpendDimension>(["operator", "project", "model", "outcome"]);
const VALID_METRICS = new Set<TrendMetric>(["cost", "error_rate", "turns", "sessions", "dead_end_rate"]);
const VALID_GRANULARITIES = new Set<TrendGranularity>(["day", "week"]);

/** Strict YYYY-MM-DD: exact format, no trailing junk, valid month/day ranges. */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return false;
  // Round-trip check catches things like 2026-02-31 → 2026-03-03
  return d.toISOString().startsWith(s);
}

/** Strict non-negative integer: no trailing letters, no floats. */
function isStrictInt(s: string): boolean {
  return /^\d+$/.test(s);
}

export function validateSpendParams(raw: Record<string, string | undefined>): { params: SpendParams } | { error: string } {
  const by = raw.by;
  if (!by || !VALID_DIMENSIONS.has(by as SpendDimension)) {
    return { error: `Invalid 'by' parameter. Must be one of: ${[...VALID_DIMENSIONS].join(", ")}` };
  }
  if (raw.from && !isValidDate(raw.from)) {
    return { error: "Invalid 'from' date. Use exact ISO date (YYYY-MM-DD) with valid month/day." };
  }
  if (raw.to && !isValidDate(raw.to)) {
    return { error: "Invalid 'to' date. Use exact ISO date (YYYY-MM-DD) with valid month/day." };
  }
  return {
    params: {
      by: by as SpendDimension,
      from: raw.from,
      to: raw.to,
      operator: raw.operator,
      project: raw.project,
    },
  };
}

export function validateTrendParams(raw: Record<string, string | undefined>): { params: TrendParams } | { error: string } {
  const metric = raw.metric;
  if (!metric || !VALID_METRICS.has(metric as TrendMetric)) {
    return { error: `Invalid 'metric' parameter. Must be one of: ${[...VALID_METRICS].join(", ")}` };
  }
  const granularity = (raw.granularity ?? "day") as TrendGranularity;
  if (!VALID_GRANULARITIES.has(granularity)) {
    return { error: `Invalid 'granularity' parameter. Must be one of: ${[...VALID_GRANULARITIES].join(", ")}` };
  }
  const rawDays = raw.days ?? "30";
  if (!isStrictInt(rawDays)) {
    return { error: "Invalid 'days' parameter. Must be an integer." };
  }
  const days = Number(rawDays);
  if (days < 1 || days > 365) {
    return { error: "Invalid 'days' parameter. Must be between 1 and 365." };
  }
  return {
    params: {
      metric: metric as TrendMetric,
      granularity,
      days,
      operator: raw.operator,
      project: raw.project,
    },
  };
}

export function validateSessionListParams(raw: Record<string, string | undefined>): { params: SessionListParams } | { error: string } {
  if (raw.from && !isValidDate(raw.from)) {
    return { error: "Invalid 'from' date. Use exact ISO date (YYYY-MM-DD) with valid month/day." };
  }
  if (raw.to && !isValidDate(raw.to)) {
    return { error: "Invalid 'to' date. Use exact ISO date (YYYY-MM-DD) with valid month/day." };
  }
  const rawLimit = raw.limit ?? "20";
  if (!isStrictInt(rawLimit)) {
    return { error: "Invalid 'limit' parameter. Must be an integer." };
  }
  const limit = Number(rawLimit);
  if (limit < 1 || limit > 100) {
    return { error: "Invalid 'limit' parameter. Must be between 1 and 100." };
  }
  const rawOffset = raw.offset ?? "0";
  if (!isStrictInt(rawOffset)) {
    return { error: "Invalid 'offset' parameter. Must be a non-negative integer." };
  }
  const offset = Number(rawOffset);
  return {
    params: {
      from: raw.from,
      to: raw.to,
      outcome: raw.outcome,
      operator: raw.operator,
      project: raw.project,
      limit,
      offset,
    },
  };
}

// ─── Query Builders ─────────────────────────────────────────────────────────

export function querySpendByDimension(params: SpendParams): SpendResult {
  const db = getDb();

  if (params.by === "model") {
    return querySpendByModel(db, params);
  }

  const dimensionColumn = DIMENSION_COLUMNS[params.by];
  const { whereClause, whereArgs } = buildSummaryFilters(params);

  const sql = `
    SELECT
      COALESCE(${dimensionColumn}, 'unknown') AS key,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COUNT(*) AS sessions,
      COALESCE(SUM(total_turns), 0) AS turns
    FROM session_summaries
    ${whereClause}
    GROUP BY key
    ORDER BY cost_usd DESC
  `;

  const rows = db.prepare(sql).all(...whereArgs) as Array<{
    key: string;
    cost_usd: number;
    sessions: number;
    turns: number;
  }>;

  return {
    dimension: params.by,
    buckets: rows.map((r) => ({
      key: r.key,
      costUsd: r.cost_usd,
      sessions: r.sessions,
      turns: r.turns,
    })),
  };
}

const DIMENSION_COLUMNS: Record<Exclude<SpendDimension, "model">, string> = {
  operator: "operator_id",
  project: "project_path",
  outcome: "outcome",
};

function querySpendByModel(
  db: ReturnType<typeof getDb>,
  params: SpendParams,
): SpendResult {
  const { whereClause, whereArgs } = buildSummaryFilters(params, "ss");

  const sql = `
    SELECT
      COALESCE(smc.model_family, 'unknown') AS key,
      COALESCE(SUM(smc.cost_usd), 0) AS cost_usd,
      COUNT(DISTINCT smc.session_id) AS sessions,
      COALESCE(SUM(smc.turn_count), 0) AS turns
    FROM session_model_costs smc
    JOIN session_summaries ss ON ss.session_id = smc.session_id
    ${whereClause}
    GROUP BY key
    ORDER BY cost_usd DESC
  `;

  const rows = db.prepare(sql).all(...whereArgs) as Array<{
    key: string;
    cost_usd: number;
    sessions: number;
    turns: number;
  }>;

  return {
    dimension: "model",
    buckets: rows.map((r) => ({
      key: r.key,
      costUsd: r.cost_usd,
      sessions: r.sessions,
      turns: r.turns,
    })),
  };
}

export function queryTrends(params: TrendParams): TrendResult {
  const db = getDb();
  const { metric, granularity, days } = params;

  // ISO week bucketing: compute the Monday of the week containing started_at.
  // SQLite's strftime('%w') returns 0=Sun,1=Mon,...,6=Sat. We subtract
  // ((%w + 6) % 7) days to get back to Monday. This is correct for all 7 days.
  const bucketExpr = granularity === "week"
    ? "date(started_at, '-' || ((strftime('%w', started_at) + 6) % 7) || ' days')"
    : "date(started_at)";

  const valueExpr = METRIC_EXPRESSIONS[metric];

  const filters: string[] = [`started_at >= date('now', '-${days} days')`];
  const args: unknown[] = [];

  if (params.operator) {
    filters.push("operator_id = ?");
    args.push(params.operator);
  }
  if (params.project) {
    filters.push("project_path = ?");
    args.push(params.project);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const sql = `
    SELECT
      ${bucketExpr} AS bucket_start,
      ${valueExpr} AS value
    FROM session_summaries
    ${whereClause}
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `;

  const rows = db.prepare(sql).all(...args) as Array<{
    bucket_start: string;
    value: number;
  }>;

  return {
    metric,
    granularity,
    points: rows.map((r) => ({
      bucketStart: r.bucket_start,
      value: r.value,
    })),
  };
}

const METRIC_EXPRESSIONS: Record<TrendMetric, string> = {
  cost: "COALESCE(SUM(total_cost_usd), 0)",
  error_rate: "CASE WHEN SUM(total_turns) > 0 THEN CAST(SUM(total_errors) AS REAL) / SUM(total_turns) ELSE 0 END",
  turns: "COALESCE(SUM(total_turns), 0)",
  sessions: "COUNT(*)",
  dead_end_rate: "CASE WHEN COUNT(*) > 0 THEN CAST(SUM(CASE WHEN is_dead_end = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) ELSE 0 END",
};

export function querySessionList(params: SessionListParams): SessionListResult {
  const db = getDb();
  const { whereClause, whereArgs } = buildSessionListFilters(params);

  const countSql = `SELECT COUNT(*) AS total FROM session_summaries ${whereClause}`;
  const countRow = db.prepare(countSql).get(...whereArgs) as { total: number };

  const sql = `
    SELECT
      session_id AS sessionId,
      provider,
      operator_id AS operatorId,
      operator_name AS operatorName,
      project_path AS projectPath,
      started_at AS startedAt,
      ended_at AS endedAt,
      duration_ms AS durationMs,
      total_cost_usd AS totalCostUsd,
      total_turns AS totalTurns,
      total_commits AS totalCommits,
      outcome,
      is_dead_end AS isDeadEnd
    FROM session_summaries
    ${whereClause}
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...whereArgs, params.limit, params.offset) as Array<{
    sessionId: string;
    provider: string;
    operatorId: string | null;
    operatorName: string | null;
    projectPath: string;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    totalCostUsd: number;
    totalTurns: number;
    totalCommits: number;
    outcome: string;
    isDeadEnd: number;
  }>;

  return {
    sessions: rows.map((r) => ({
      ...r,
      isDeadEnd: r.isDeadEnd === 1,
    })),
    total: countRow.total,
    limit: params.limit,
    offset: params.offset,
  };
}

// ─── Filter Builders ────────────────────────────────────────────────────────

function buildSummaryFilters(
  params: { from?: string; to?: string; operator?: string; project?: string },
  tableAlias?: string,
): { whereClause: string; whereArgs: unknown[] } {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const filters: string[] = [];
  const args: unknown[] = [];

  if (params.from) {
    filters.push(`${prefix}started_at >= ?`);
    args.push(params.from);
  }
  if (params.to) {
    filters.push(`${prefix}started_at < ?`);
    args.push(params.to);
  }
  if (params.operator) {
    filters.push(`${prefix}operator_id = ?`);
    args.push(params.operator);
  }
  if (params.project) {
    filters.push(`${prefix}project_path = ?`);
    args.push(params.project);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  return { whereClause, whereArgs: args };
}

function buildSessionListFilters(
  params: SessionListParams,
): { whereClause: string; whereArgs: unknown[] } {
  const filters: string[] = [];
  const args: unknown[] = [];

  if (params.from) {
    filters.push("started_at >= ?");
    args.push(params.from);
  }
  if (params.to) {
    filters.push("started_at < ?");
    args.push(params.to);
  }
  if (params.outcome) {
    filters.push("outcome = ?");
    args.push(params.outcome);
  }
  if (params.operator) {
    filters.push("operator_id = ?");
    args.push(params.operator);
  }
  if (params.project) {
    filters.push("project_path = ?");
    args.push(params.project);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  return { whereClause, whereArgs: args };
}

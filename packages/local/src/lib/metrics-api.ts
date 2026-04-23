const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:7433";

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ─── Types (mirrors server response shapes) ────────────────────────────────

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

export interface TrendPoint {
  bucketStart: string;
  value: number;
}

export interface TrendResult {
  metric: string;
  granularity: string;
  points: TrendPoint[];
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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
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

// ─── API Functions ──────────────────────────────────────────────────────────

export async function fetchSpend(
  by: "model" | "operator" | "project" | "outcome",
  from?: string,
): Promise<SpendResult> {
  const params = new URLSearchParams({ by });
  if (from) params.set("from", from);
  return fetchApi<SpendResult>(`/api/metrics/spend?${params}`);
}

export async function fetchTrends(
  metric: string = "cost",
  days: number = 14,
  granularity: string = "day",
): Promise<TrendResult> {
  const params = new URLSearchParams({
    metric,
    days: String(days),
    granularity,
  });
  return fetchApi<TrendResult>(`/api/metrics/trends?${params}`);
}

export async function fetchSessions(
  from?: string,
  limit: number = 50,
  offset: number = 0,
): Promise<SessionListResult> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (from) params.set("from", from);
  return fetchApi<SessionListResult>(`/api/metrics/sessions?${params}`);
}

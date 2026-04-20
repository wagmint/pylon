"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  fetchSpend,
  fetchSessions,
  fetchTrends,
  type SpendResult,
  type SessionListResult,
  type TrendResult,
} from "@/lib/metrics-api";

export type Period = "today" | "week" | "month";

export interface SpendMetrics {
  sessions: SessionListResult | null;
  spend: SpendResult | null;
  trends: TrendResult | null;
  loading: boolean;
}

function periodToFrom(period: Period): string {
  const now = new Date();
  switch (period) {
    case "today":
      return now.toISOString().slice(0, 10);
    case "week": {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
      const monday = new Date(now);
      monday.setDate(now.getDate() - diff);
      return monday.toISOString().slice(0, 10);
    }
    case "month":
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  }
}

const REFRESH_MS = 30_000;

export function useSpendMetrics(period: Period): SpendMetrics {
  const [sessions, setSessions] = useState<SessionListResult | null>(null);
  const [spend, setSpend] = useState<SpendResult | null>(null);
  const [trends, setTrends] = useState<TrendResult | null>(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const load = useCallback(async () => {
    const from = periodToFrom(period);
    try {
      const [sessRes, spendRes, trendRes] = await Promise.all([
        fetchSessions(from, 50),
        fetchSpend("model", from),
        fetchTrends("cost", 14, "day"),
      ]);
      setSessions(sessRes);
      setSpend(spendRes);
      setTrends(trendRes);
    } catch {
      // Keep stale data on error
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    setLoading(true);
    load();
    intervalRef.current = setInterval(load, REFRESH_MS);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  return { sessions, spend, trends, loading };
}

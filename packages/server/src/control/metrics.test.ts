import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SqliteDatabase } from "../storage/sqlite.js";

interface LoadedModules {
  getDb: () => SqliteDatabase;
  initStorage: () => Promise<unknown>;
  closeStorage: () => void;
  querySpendByDimension: typeof import("./metrics.js").querySpendByDimension;
  queryTrends: typeof import("./metrics.js").queryTrends;
  querySessionList: typeof import("./metrics.js").querySessionList;
  validateSpendParams: typeof import("./metrics.js").validateSpendParams;
  validateTrendParams: typeof import("./metrics.js").validateTrendParams;
  validateSessionListParams: typeof import("./metrics.js").validateSessionListParams;
}

const tempRoots: string[] = [];
const storageClosers: Array<() => void> = [];

afterEach(() => {
  for (const close of storageClosers.splice(0)) close();
  delete process.env.HEXDECK_HOME_DIR;
  delete process.env.HEXDECK_CLAUDE_DIR;
  delete process.env.HEXDECK_STORAGE_PARSER_VERSION;
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Spend Endpoint Tests ────────────────────────────────────────────────────

describe("querySpendByDimension", () => {
  it("groups spend by operator", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", operatorId: "jake", totalCostUsd: 10.5, totalTurns: 50, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", operatorId: "jake", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-10T11:00:00Z" });
    insertSummary(db, { sessionId: "s3", operatorId: "alex", totalCostUsd: 3.0, totalTurns: 15, startedAt: "2026-04-10T12:00:00Z" });

    const result = mod.querySpendByDimension({ by: "operator" });
    expect(result.dimension).toBe("operator");
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].key).toBe("jake");
    expect(result.buckets[0].costUsd).toBeCloseTo(15.5);
    expect(result.buckets[0].sessions).toBe(2);
    expect(result.buckets[0].turns).toBe(70);
    expect(result.buckets[1].key).toBe("alex");
    expect(result.buckets[1].costUsd).toBeCloseTo(3.0);
  });

  it("groups spend by project", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", projectPath: "/app/payments", totalCostUsd: 8.0, totalTurns: 30, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", projectPath: "/app/auth", totalCostUsd: 4.0, totalTurns: 20, startedAt: "2026-04-10T11:00:00Z" });
    insertSummary(db, { sessionId: "s3", projectPath: "/app/payments", totalCostUsd: 2.0, totalTurns: 10, startedAt: "2026-04-10T12:00:00Z" });

    const result = mod.querySpendByDimension({ by: "project" });
    expect(result.dimension).toBe("project");
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].key).toBe("/app/payments");
    expect(result.buckets[0].costUsd).toBeCloseTo(10.0);
    expect(result.buckets[1].key).toBe("/app/auth");
  });

  it("groups spend by model (via session_model_costs)", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", totalCostUsd: 12.0, totalTurns: 40, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-10T11:00:00Z" });
    insertModelCost(db, { sessionId: "s1", modelFamily: "opus-4.6", costUsd: 10.0, turnCount: 30 });
    insertModelCost(db, { sessionId: "s1", modelFamily: "sonnet-4.5", costUsd: 2.0, turnCount: 10 });
    insertModelCost(db, { sessionId: "s2", modelFamily: "opus-4.6", costUsd: 5.0, turnCount: 20 });

    const result = mod.querySpendByDimension({ by: "model" });
    expect(result.dimension).toBe("model");
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].key).toBe("opus-4.6");
    expect(result.buckets[0].costUsd).toBeCloseTo(15.0);
    expect(result.buckets[0].sessions).toBe(2);
    expect(result.buckets[0].turns).toBe(50);
    expect(result.buckets[1].key).toBe("sonnet-4.5");
    expect(result.buckets[1].costUsd).toBeCloseTo(2.0);
  });

  it("groups spend by outcome", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", outcome: "productive", totalCostUsd: 20.0, totalTurns: 50, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", outcome: "dead_end:spinning", totalCostUsd: 8.0, totalTurns: 30, startedAt: "2026-04-10T11:00:00Z" });
    insertSummary(db, { sessionId: "s3", outcome: "productive", totalCostUsd: 5.0, totalTurns: 15, startedAt: "2026-04-10T12:00:00Z" });

    const result = mod.querySpendByDimension({ by: "outcome" });
    expect(result.dimension).toBe("outcome");
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].key).toBe("productive");
    expect(result.buckets[0].costUsd).toBeCloseTo(25.0);
    expect(result.buckets[1].key).toBe("dead_end:spinning");
  });

  it("filters by date range", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", operatorId: "jake", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2026-04-05T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", operatorId: "jake", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s3", operatorId: "jake", totalCostUsd: 3.0, totalTurns: 10, startedAt: "2026-04-15T10:00:00Z" });

    const result = mod.querySpendByDimension({
      by: "operator",
      from: "2026-04-08",
      to: "2026-04-12",
    });
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].costUsd).toBeCloseTo(5.0);
    expect(result.buckets[0].sessions).toBe(1);
  });

  it("filters by operator", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", operatorId: "jake", projectPath: "/app/a", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", operatorId: "alex", projectPath: "/app/b", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-10T11:00:00Z" });

    const result = mod.querySpendByDimension({ by: "project", operator: "jake" });
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].key).toBe("/app/a");
  });

  it("returns empty buckets when no data", async () => {
    const mod = await setup();
    const result = mod.querySpendByDimension({ by: "operator" });
    expect(result.dimension).toBe("operator");
    expect(result.buckets).toEqual([]);
  });

  it("compound filter: operator + date range", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", operatorId: "jake", projectPath: "/app/a", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", operatorId: "jake", projectPath: "/app/b", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-20T10:00:00Z" });
    insertSummary(db, { sessionId: "s3", operatorId: "alex", projectPath: "/app/a", totalCostUsd: 3.0, totalTurns: 10, startedAt: "2026-04-10T10:00:00Z" });

    const result = mod.querySpendByDimension({
      by: "project",
      operator: "jake",
      from: "2026-04-01",
      to: "2026-04-15",
    });
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].key).toBe("/app/a");
    expect(result.buckets[0].costUsd).toBeCloseTo(10.0);
  });
});

// ─── Trend Endpoint Tests ────────────────────────────────────────────────────

describe("queryTrends", () => {
  it("returns daily cost trend", async () => {
    const mod = await setup();
    const db = mod.getDb();

    // Use relative dates so the "last 30 days" filter works
    const today = new Date();
    const d1 = offsetDate(today, -2);
    const d2 = offsetDate(today, -1);

    insertSummary(db, { sessionId: "s1", totalCostUsd: 10.0, totalTurns: 30, startedAt: `${d1}T10:00:00Z` });
    insertSummary(db, { sessionId: "s2", totalCostUsd: 5.0, totalTurns: 20, startedAt: `${d1}T14:00:00Z` });
    insertSummary(db, { sessionId: "s3", totalCostUsd: 8.0, totalTurns: 25, startedAt: `${d2}T10:00:00Z` });

    const result = mod.queryTrends({ metric: "cost", granularity: "day", days: 30 });
    expect(result.metric).toBe("cost");
    expect(result.granularity).toBe("day");
    expect(result.points.length).toBeGreaterThanOrEqual(2);

    const day1 = result.points.find((p) => p.bucketStart === d1);
    const day2 = result.points.find((p) => p.bucketStart === d2);
    expect(day1).toBeDefined();
    expect(day1!.value).toBeCloseTo(15.0);
    expect(day2).toBeDefined();
    expect(day2!.value).toBeCloseTo(8.0);
  });

  it("returns daily error_rate trend", async () => {
    const mod = await setup();
    const db = mod.getDb();

    const today = new Date();
    const d1 = offsetDate(today, -1);

    insertSummary(db, { sessionId: "s1", totalTurns: 10, totalErrors: 2, totalCostUsd: 1.0, startedAt: `${d1}T10:00:00Z` });
    insertSummary(db, { sessionId: "s2", totalTurns: 20, totalErrors: 4, totalCostUsd: 2.0, startedAt: `${d1}T14:00:00Z` });

    const result = mod.queryTrends({ metric: "error_rate", granularity: "day", days: 30 });
    const point = result.points.find((p) => p.bucketStart === d1);
    expect(point).toBeDefined();
    // (2 + 4) / (10 + 20) = 0.2
    expect(point!.value).toBeCloseTo(0.2);
  });

  it("returns daily sessions count", async () => {
    const mod = await setup();
    const db = mod.getDb();

    const today = new Date();
    const d1 = offsetDate(today, -1);

    insertSummary(db, { sessionId: "s1", totalTurns: 10, totalCostUsd: 1.0, startedAt: `${d1}T10:00:00Z` });
    insertSummary(db, { sessionId: "s2", totalTurns: 20, totalCostUsd: 2.0, startedAt: `${d1}T14:00:00Z` });

    const result = mod.queryTrends({ metric: "sessions", granularity: "day", days: 30 });
    const point = result.points.find((p) => p.bucketStart === d1);
    expect(point).toBeDefined();
    expect(point!.value).toBe(2);
  });

  it("returns daily dead_end_rate trend", async () => {
    const mod = await setup();
    const db = mod.getDb();

    const today = new Date();
    const d1 = offsetDate(today, -1);

    insertSummary(db, { sessionId: "s1", totalTurns: 10, totalCostUsd: 1.0, startedAt: `${d1}T10:00:00Z`, isDeadEnd: 1 });
    insertSummary(db, { sessionId: "s2", totalTurns: 20, totalCostUsd: 2.0, startedAt: `${d1}T12:00:00Z` });
    insertSummary(db, { sessionId: "s3", totalTurns: 15, totalCostUsd: 1.5, startedAt: `${d1}T14:00:00Z`, isDeadEnd: 1 });

    const result = mod.queryTrends({ metric: "dead_end_rate", granularity: "day", days: 30 });
    const point = result.points.find((p) => p.bucketStart === d1);
    expect(point).toBeDefined();
    // 2 dead ends / 3 sessions = 0.667
    expect(point!.value).toBeCloseTo(2 / 3);
  });

  it("filters trends by operator", async () => {
    const mod = await setup();
    const db = mod.getDb();

    const today = new Date();
    const d1 = offsetDate(today, -1);

    insertSummary(db, { sessionId: "s1", operatorId: "jake", totalCostUsd: 10.0, totalTurns: 30, startedAt: `${d1}T10:00:00Z` });
    insertSummary(db, { sessionId: "s2", operatorId: "alex", totalCostUsd: 5.0, totalTurns: 20, startedAt: `${d1}T12:00:00Z` });

    const result = mod.queryTrends({ metric: "cost", granularity: "day", days: 30, operator: "jake" });
    const point = result.points.find((p) => p.bucketStart === d1);
    expect(point).toBeDefined();
    expect(point!.value).toBeCloseTo(10.0);
  });

  it("returns empty points when no data in range", async () => {
    const mod = await setup();
    const result = mod.queryTrends({ metric: "cost", granularity: "day", days: 7 });
    expect(result.points).toEqual([]);
  });

  it("weekly granularity groups all 7 days to correct Monday", async () => {
    const mod = await setup();
    const db = mod.getDb();

    // Week of 2026-04-06 (Monday) through 2026-04-12 (Sunday)
    // All 7 days should bucket to Monday 2026-04-06
    insertSummary(db, { sessionId: "s-mon", totalCostUsd: 1.0, totalTurns: 5, startedAt: "2026-04-06T10:00:00Z" }); // Monday
    insertSummary(db, { sessionId: "s-tue", totalCostUsd: 1.0, totalTurns: 5, startedAt: "2026-04-07T10:00:00Z" }); // Tuesday
    insertSummary(db, { sessionId: "s-wed", totalCostUsd: 1.0, totalTurns: 5, startedAt: "2026-04-08T10:00:00Z" }); // Wednesday
    insertSummary(db, { sessionId: "s-thu", totalCostUsd: 1.0, totalTurns: 5, startedAt: "2026-04-09T10:00:00Z" }); // Thursday
    insertSummary(db, { sessionId: "s-fri", totalCostUsd: 1.0, totalTurns: 5, startedAt: "2026-04-10T10:00:00Z" }); // Friday
    insertSummary(db, { sessionId: "s-sat", totalCostUsd: 1.0, totalTurns: 5, startedAt: "2026-04-11T10:00:00Z" }); // Saturday
    insertSummary(db, { sessionId: "s-sun", totalCostUsd: 1.0, totalTurns: 5, startedAt: "2026-04-12T10:00:00Z" }); // Sunday
    // Next week Monday
    insertSummary(db, { sessionId: "s-next", totalCostUsd: 2.0, totalTurns: 10, startedAt: "2026-04-13T10:00:00Z" }); // Monday

    const result = mod.queryTrends({ metric: "cost", granularity: "week", days: 30 });
    expect(result.granularity).toBe("week");
    expect(result.points).toHaveLength(2);

    // All 7 days bucket to Monday 2026-04-06
    const week1 = result.points.find((p) => p.bucketStart === "2026-04-06");
    expect(week1).toBeDefined();
    expect(week1!.value).toBeCloseTo(7.0);

    // Next Monday is a separate bucket
    const week2 = result.points.find((p) => p.bucketStart === "2026-04-13");
    expect(week2).toBeDefined();
    expect(week2!.value).toBeCloseTo(2.0);
  });

  it("weekly bucketing handles year boundary correctly", async () => {
    const mod = await setup();
    const db = mod.getDb();

    // 2025-12-31 is a Wednesday — its ISO week starts Mon 2025-12-29
    // 2026-01-01 is a Thursday — same ISO week as Dec 31
    insertSummary(db, { sessionId: "s1", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2025-12-31T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-01-01T10:00:00Z" });

    const result = mod.queryTrends({ metric: "cost", granularity: "week", days: 365 });
    // Both should land in the same weekly bucket (Monday 2025-12-29)
    expect(result.points).toHaveLength(1);
    expect(result.points[0].bucketStart).toBe("2025-12-29");
    expect(result.points[0].value).toBeCloseTo(15.0);
  });
});

// ─── Session List Endpoint Tests ─────────────────────────────────────────────

describe("querySessionList", () => {
  it("returns paginated session list ordered by started_at DESC", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-11T10:00:00Z" });
    insertSummary(db, { sessionId: "s3", totalCostUsd: 3.0, totalTurns: 15, startedAt: "2026-04-12T10:00:00Z" });

    const result = mod.querySessionList({ limit: 2, offset: 0 });
    expect(result.total).toBe(3);
    expect(result.limit).toBe(2);
    expect(result.offset).toBe(0);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].sessionId).toBe("s3"); // most recent first
    expect(result.sessions[1].sessionId).toBe("s2");
  });

  it("supports offset pagination", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-11T10:00:00Z" });
    insertSummary(db, { sessionId: "s3", totalCostUsd: 3.0, totalTurns: 15, startedAt: "2026-04-12T10:00:00Z" });

    const page2 = mod.querySessionList({ limit: 2, offset: 2 });
    expect(page2.total).toBe(3);
    expect(page2.sessions).toHaveLength(1);
    expect(page2.sessions[0].sessionId).toBe("s1");
  });

  it("filters by outcome", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", outcome: "productive", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", outcome: "dead_end:spinning", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-11T10:00:00Z", isDeadEnd: 1 });
    insertSummary(db, { sessionId: "s3", outcome: "productive", totalCostUsd: 3.0, totalTurns: 15, startedAt: "2026-04-12T10:00:00Z" });

    const result = mod.querySessionList({ outcome: "dead_end:spinning", limit: 20, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.sessions[0].sessionId).toBe("s2");
    expect(result.sessions[0].isDeadEnd).toBe(true);
  });

  it("filters by date range", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2026-04-05T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s3", totalCostUsd: 3.0, totalTurns: 15, startedAt: "2026-04-15T10:00:00Z" });

    const result = mod.querySessionList({
      from: "2026-04-08",
      to: "2026-04-12",
      limit: 20,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.sessions[0].sessionId).toBe("s2");
  });

  it("filters by operator", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", operatorId: "jake", totalCostUsd: 10.0, totalTurns: 30, startedAt: "2026-04-10T10:00:00Z" });
    insertSummary(db, { sessionId: "s2", operatorId: "alex", totalCostUsd: 5.0, totalTurns: 20, startedAt: "2026-04-11T10:00:00Z" });

    const result = mod.querySessionList({ operator: "jake", limit: 20, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.sessions[0].sessionId).toBe("s1");
    expect(result.sessions[0].operatorId).toBe("jake");
  });

  it("returns isDeadEnd as boolean", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, { sessionId: "s1", totalCostUsd: 1.0, totalTurns: 5, startedAt: "2026-04-10T10:00:00Z", isDeadEnd: 1, outcome: "dead_end:abandoned" });
    insertSummary(db, { sessionId: "s2", totalCostUsd: 2.0, totalTurns: 10, startedAt: "2026-04-11T10:00:00Z" });

    const result = mod.querySessionList({ limit: 20, offset: 0 });
    expect(result.sessions.find((s) => s.sessionId === "s1")!.isDeadEnd).toBe(true);
    expect(result.sessions.find((s) => s.sessionId === "s2")!.isDeadEnd).toBe(false);
  });

  it("returns token totals for each session", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSummary(db, {
      sessionId: "s1",
      startedAt: "2026-04-10T10:00:00Z",
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheReadTokens: 25,
      totalCacheCreationTokens: 10,
    });

    const result = mod.querySessionList({ limit: 20, offset: 0 });
    expect(result.sessions[0].totalInputTokens).toBe(100);
    expect(result.sessions[0].totalOutputTokens).toBe(50);
    expect(result.sessions[0].totalCacheReadTokens).toBe(25);
    expect(result.sessions[0].totalCacheCreationTokens).toBe(10);
  });

  it("returns empty result when no sessions match", async () => {
    const mod = await setup();
    const result = mod.querySessionList({ outcome: "productive", limit: 20, offset: 0 });
    expect(result.total).toBe(0);
    expect(result.sessions).toEqual([]);
  });
});

// ─── Validation Tests ────────────────────────────────────────────────────────

describe("parameter validation", () => {
  it("rejects invalid spend dimension", async () => {
    const mod = await setup();
    const result = mod.validateSpendParams({ by: "invalid" });
    expect("error" in result).toBe(true);
  });

  it("rejects missing spend dimension", async () => {
    const mod = await setup();
    const result = mod.validateSpendParams({});
    expect("error" in result).toBe(true);
  });

  it("rejects invalid from date", async () => {
    const mod = await setup();
    const result = mod.validateSpendParams({ by: "operator", from: "not-a-date" });
    expect("error" in result).toBe(true);
  });

  it("rejects date with trailing junk (2026-04-01junk)", async () => {
    const mod = await setup();
    const result = mod.validateSpendParams({ by: "operator", from: "2026-04-01junk" });
    expect("error" in result).toBe(true);
  });

  it("rejects impossible date (2026-02-31)", async () => {
    const mod = await setup();
    const result = mod.validateSpendParams({ by: "operator", from: "2026-02-31" });
    expect("error" in result).toBe(true);
  });

  it("rejects out-of-range month (2026-99-01)", async () => {
    const mod = await setup();
    const result = mod.validateSpendParams({ by: "operator", from: "2026-99-01" });
    expect("error" in result).toBe(true);
  });

  it("accepts valid spend params", async () => {
    const mod = await setup();
    const result = mod.validateSpendParams({ by: "operator", from: "2026-04-01", to: "2026-04-15" });
    expect("params" in result).toBe(true);
  });

  it("rejects invalid trend metric", async () => {
    const mod = await setup();
    const result = mod.validateTrendParams({ metric: "invalid" });
    expect("error" in result).toBe(true);
  });

  it("rejects invalid granularity", async () => {
    const mod = await setup();
    const result = mod.validateTrendParams({ metric: "cost", granularity: "month" });
    expect("error" in result).toBe(true);
  });

  it("rejects out-of-range days", async () => {
    const mod = await setup();
    const result = mod.validateTrendParams({ metric: "cost", days: "0" });
    expect("error" in result).toBe(true);
  });

  it("rejects days with trailing letters (30abc)", async () => {
    const mod = await setup();
    const result = mod.validateTrendParams({ metric: "cost", days: "30abc" });
    expect("error" in result).toBe(true);
  });

  it("accepts valid trend params with defaults", async () => {
    const mod = await setup();
    const result = mod.validateTrendParams({ metric: "cost" });
    expect("params" in result).toBe(true);
    if ("params" in result) {
      expect(result.params.granularity).toBe("day");
      expect(result.params.days).toBe(30);
    }
  });

  it("rejects invalid session list limit", async () => {
    const mod = await setup();
    const result = mod.validateSessionListParams({ limit: "0" });
    expect("error" in result).toBe(true);
  });

  it("rejects limit with trailing letters (20abc)", async () => {
    const mod = await setup();
    const result = mod.validateSessionListParams({ limit: "20abc" });
    expect("error" in result).toBe(true);
  });

  it("rejects negative session list offset", async () => {
    const mod = await setup();
    const result = mod.validateSessionListParams({ offset: "-1" });
    expect("error" in result).toBe(true);
  });
});

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-metrics-"));
  tempRoots.push(root);
  return root;
}

async function setup(): Promise<LoadedModules> {
  const root = createFixtureRoot();
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "metrics-test";
  vi.resetModules();

  const dbMod = await import("../storage/db.js");
  const metrics = await import("./metrics.js");

  storageClosers.push(() => {
    try {
      dbMod.closeStorage();
    } catch {}
  });

  await dbMod.initStorage();

  return {
    getDb: dbMod.getDb,
    initStorage: dbMod.initStorage,
    closeStorage: dbMod.closeStorage,
    querySpendByDimension: metrics.querySpendByDimension,
    queryTrends: metrics.queryTrends,
    querySessionList: metrics.querySessionList,
    validateSpendParams: metrics.validateSpendParams,
    validateTrendParams: metrics.validateTrendParams,
    validateSessionListParams: metrics.validateSessionListParams,
  };
}

/** Insert parent sessions row to satisfy FK constraint, then session_summaries row. */
function insertSummary(
  db: SqliteDatabase,
  opts: {
    sessionId: string;
    provider?: string;
    operatorId?: string;
    operatorName?: string;
    projectPath?: string;
    startedAt: string;
    endedAt?: string;
    totalTurns?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
    totalCostUsd?: number;
    totalCommits?: number;
    totalErrors?: number;
    outcome?: string;
    isDeadEnd?: number;
    deadEndReason?: string;
  },
): void {
  // Insert parent sessions row (FK target)
  db.prepare(`
    INSERT OR IGNORE INTO sessions(id, source_type, project_path, cwd, created_at, last_event_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'ended')
  `).run(
    opts.sessionId,
    opts.provider ?? "claude",
    opts.projectPath ?? "/tmp/project",
    opts.projectPath ?? "/tmp/project",
    opts.startedAt,
    opts.endedAt ?? opts.startedAt,
  );

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
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'nominal', 0, NULL, 0, 0, ?, ?, ?, NULL, NULL, NULL, ?)
  `).run(
    opts.sessionId,
    opts.provider ?? "claude",
    opts.operatorId ?? "self",
    opts.operatorName ?? "Self",
    opts.projectPath ?? "/tmp/project",
    opts.startedAt,
    opts.endedAt ?? null,
    opts.totalTurns ?? 0,
    opts.totalInputTokens ?? 0,
    opts.totalOutputTokens ?? 0,
    opts.totalCacheReadTokens ?? 0,
    opts.totalCacheCreationTokens ?? 0,
    opts.totalCostUsd ?? 0,
    opts.totalCommits ?? 0,
    opts.totalErrors ?? 0,
    (opts.totalErrors ?? 0) > 0 && (opts.totalTurns ?? 0) > 0
      ? (opts.totalErrors ?? 0) / (opts.totalTurns ?? 1)
      : 0,
    opts.outcome ?? "unknown",
    opts.isDeadEnd ?? 0,
    opts.deadEndReason ?? null,
    new Date().toISOString(),
  );
}

/** Insert a session_model_costs row directly for testing. */
function insertModelCost(
  db: SqliteDatabase,
  opts: {
    sessionId: string;
    modelFamily: string;
    costUsd: number;
    turnCount: number;
    inputTokens?: number;
    outputTokens?: number;
  },
): void {
  db.prepare(`
    INSERT INTO session_model_costs(
      session_id, model_family, turn_count,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd
    )
    VALUES (?, ?, ?, ?, ?, 0, 0, ?)
  `).run(
    opts.sessionId,
    opts.modelFamily,
    opts.turnCount,
    opts.inputTokens ?? 0,
    opts.outputTokens ?? 0,
    opts.costUsd,
  );
}

/** Format a Date offset from today as YYYY-MM-DD for SQLite date comparison. */
function offsetDate(base: Date, daysDelta: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + daysDelta);
  return d.toISOString().slice(0, 10);
}

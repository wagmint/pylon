import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SqliteDatabase } from "./sqlite.js";

interface LoadedModules {
  getDb: () => SqliteDatabase;
  initStorage: () => Promise<unknown>;
  closeStorage: () => void;
  materializeSessionSummary: (sessionId: string) => import("./session-summaries.js").SessionSummaryRow | null;
  materializePendingSummaries: () => number;
  getSessionSummary: (sessionId: string) => import("./session-summaries.js").SessionSummaryRow | null;
  listSessionModelCosts: (sessionId: string) => import("./session-summaries.js").SessionModelCostRow[];
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

describe("session summaries materializer", () => {
  it("materializes summary for ended session with turns and commits", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, {
      id: "sess-1",
      sourceType: "claude",
      projectPath: "/tmp/project-a",
      gitBranch: "main",
      createdAt: "2026-04-10T10:00:00.000Z",
      endedAt: "2026-04-10T11:30:00.000Z",
    });
    insertTurn(db, { sessionId: "sess-1", turnIndex: 0, startedAt: "2026-04-10T10:00:05.000Z", inputTokens: 1000, outputTokens: 500, cacheRead: 200, cacheCreation: 50, costUsd: 0.01, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    insertTurn(db, { sessionId: "sess-1", turnIndex: 1, startedAt: "2026-04-10T10:15:00.000Z", inputTokens: 2000, outputTokens: 800, cacheRead: 300, cacheCreation: 100, costUsd: 0.02, modelFamily: "opus", errorCount: 1, hasCompaction: 0 });
    insertTurn(db, { sessionId: "sess-1", turnIndex: 2, startedAt: "2026-04-10T10:30:00.000Z", inputTokens: 500, outputTokens: 200, cacheRead: 0, cacheCreation: 0, costUsd: 0.005, modelFamily: "sonnet", errorCount: 0, hasCompaction: 1 });
    insertCommit(db, "sess-1", 1);
    insertCommit(db, "sess-1", 2);

    const result = mod.materializeSessionSummary("sess-1");
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-1");
    expect(result!.provider).toBe("claude");
    expect(result!.projectPath).toBe("/tmp/project-a");
    expect(result!.gitBranch).toBe("main");
    // started_at should be MIN(turns.started_at), not sessions.created_at
    expect(result!.startedAt).toBe("2026-04-10T10:00:05.000Z");
    expect(result!.endedAt).toBe("2026-04-10T11:30:00.000Z");
    // duration from first turn to ended_at
    const expectedDuration = new Date("2026-04-10T11:30:00.000Z").getTime() - new Date("2026-04-10T10:00:05.000Z").getTime();
    expect(result!.durationMs).toBe(expectedDuration);
    expect(result!.isPartial).toBe(0);
    expect(result!.totalTurns).toBe(3);
    expect(result!.totalInputTokens).toBe(3500);
    expect(result!.totalOutputTokens).toBe(1500);
    expect(result!.totalCacheReadTokens).toBe(500);
    expect(result!.totalCacheCreationTokens).toBe(150);
    expect(result!.totalCostUsd).toBeCloseTo(0.035);
    expect(result!.totalCommits).toBe(2);
    expect(result!.totalErrors).toBe(1);
    expect(result!.errorRate).toBeCloseTo(1 / 3);
    expect(result!.totalCompactions).toBe(1);
    // Enrichment defaults
    expect(result!.riskPeak).toBe("nominal");
    expect(result!.hadSpinning).toBe(0);
    expect(result!.spinningTypes).toBeNull();
    expect(result!.plansCreated).toBe(0);
    expect(result!.plansCompleted).toBe(0);
    expect(result!.outcome).toBe("unknown");
    expect(result!.isDeadEnd).toBe(0);
    expect(result!.deadEndReason).toBeNull();
    expect(result!.operatorId).toBeNull();
    expect(result!.operatorName).toBeNull();

    // Verify it's persisted
    const stored = mod.getSessionSummary("sess-1");
    expect(stored).not.toBeNull();
    expect(stored!.totalTurns).toBe(3);
    expect(stored!.provider).toBe("claude");
  });

  it("groups model costs correctly by model family", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "sess-mc", sourceType: "claude", projectPath: "/tmp/mc", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    insertTurn(db, { sessionId: "sess-mc", turnIndex: 0, inputTokens: 1000, outputTokens: 500, cacheRead: 0, cacheCreation: 0, costUsd: 0.01, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    insertTurn(db, { sessionId: "sess-mc", turnIndex: 1, inputTokens: 2000, outputTokens: 1000, cacheRead: 0, cacheCreation: 0, costUsd: 0.05, modelFamily: "opus", errorCount: 0, hasCompaction: 0 });
    insertTurn(db, { sessionId: "sess-mc", turnIndex: 2, inputTokens: 500, outputTokens: 250, cacheRead: 0, cacheCreation: 0, costUsd: 0.008, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    mod.materializeSessionSummary("sess-mc");

    const costs = mod.listSessionModelCosts("sess-mc");
    expect(costs).toHaveLength(2);

    // Ordered by cost_usd DESC
    const opus = costs.find((c) => c.modelFamily === "opus");
    const sonnet = costs.find((c) => c.modelFamily === "sonnet");

    expect(opus).toMatchObject({
      modelFamily: "opus",
      turnCount: 1,
      inputTokens: 2000,
      outputTokens: 1000,
    });
    expect(opus!.costUsd).toBeCloseTo(0.05);

    expect(sonnet).toMatchObject({
      modelFamily: "sonnet",
      turnCount: 2,
      inputTokens: 1500,
      outputTokens: 750,
    });
    expect(sonnet!.costUsd).toBeCloseTo(0.018);
  });

  it("materializePendingSummaries finds ended sessions only", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "ended-1", sourceType: "claude", projectPath: "/tmp/p1", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z", status: "ended" });
    insertTurn(db, { sessionId: "ended-1", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    insertSession(db, { id: "active-1", sourceType: "claude", projectPath: "/tmp/p2", createdAt: "2026-04-10T12:00:00.000Z" });
    insertTurn(db, { sessionId: "active-1", turnIndex: 0, inputTokens: 200, outputTokens: 100, cacheRead: 0, cacheCreation: 0, costUsd: 0.002, modelFamily: "haiku", errorCount: 0, hasCompaction: 0 });

    const count = mod.materializePendingSummaries();
    expect(count).toBe(1);

    expect(mod.getSessionSummary("ended-1")).not.toBeNull();
    expect(mod.getSessionSummary("ended-1")!.isPartial).toBe(0);
    expect(mod.getSessionSummary("active-1")).toBeNull();
  });

  it("upsert is idempotent — materializing twice produces single row with updated timestamp", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "idem-1", sourceType: "claude", projectPath: "/tmp/idem", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    insertTurn(db, { sessionId: "idem-1", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    const first = mod.materializeSessionSummary("idem-1");
    expect(first).not.toBeNull();
    const firstSummarizedAt = first!.summarizedAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    const second = mod.materializeSessionSummary("idem-1");
    expect(second).not.toBeNull();
    expect(second!.summarizedAt).not.toBe(firstSummarizedAt);

    // Only one row in the table
    const rowCount = (db.prepare(`SELECT COUNT(*) as c FROM session_summaries WHERE session_id = ?`).get("idem-1") as { c: number }).c;
    expect(rowCount).toBe(1);
  });

  it("handles session with no turns", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "empty-1", sourceType: "claude", projectPath: "/tmp/empty", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T10:05:00.000Z" });

    const result = mod.materializeSessionSummary("empty-1");
    expect(result).not.toBeNull();
    expect(result!.totalTurns).toBe(0);
    expect(result!.totalInputTokens).toBe(0);
    expect(result!.totalOutputTokens).toBe(0);
    expect(result!.totalCostUsd).toBe(0);
    expect(result!.totalCommits).toBe(0);
    expect(result!.totalErrors).toBe(0);
    expect(result!.errorRate).toBe(0);
    expect(result!.totalCompactions).toBe(0);
    expect(result!.isPartial).toBe(0);
    // With no turns, falls back to sessions.created_at for started_at
    expect(result!.startedAt).toBe("2026-04-10T10:00:00.000Z");
    expect(result!.durationMs).toBe(5 * 60 * 1000);

    const costs = mod.listSessionModelCosts("empty-1");
    expect(costs).toHaveLength(0);
  });

  it("creates partial summary for session without ended_at", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "partial-1", sourceType: "claude", projectPath: "/tmp/partial", createdAt: "2026-04-10T10:00:00.000Z" });
    insertTurn(db, { sessionId: "partial-1", turnIndex: 0, inputTokens: 500, outputTokens: 200, cacheRead: 0, cacheCreation: 0, costUsd: 0.005, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    const result = mod.materializeSessionSummary("partial-1");
    expect(result).not.toBeNull();
    expect(result!.isPartial).toBe(1);
    expect(result!.durationMs).toBeNull();
    expect(result!.endedAt).toBeNull();
    expect(result!.totalTurns).toBe(1);
  });

  it("returns null for nonexistent session", async () => {
    const mod = await setup();
    const result = mod.materializeSessionSummary("does-not-exist");
    expect(result).toBeNull();
  });

  it("materializes summary for Codex session", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, {
      id: "codex-sess-1",
      sourceType: "codex",
      projectPath: "/tmp/codex-project",
      createdAt: "2026-04-10T14:00:00.000Z",
      endedAt: "2026-04-10T15:00:00.000Z",
      status: "ended",
    });
    insertTurn(db, { sessionId: "codex-sess-1", turnIndex: 0, startedAt: "2026-04-10T14:00:01.000Z", inputTokens: 800, outputTokens: 400, cacheRead: 100, cacheCreation: 20, costUsd: 0.008, modelFamily: "gpt-4.1", errorCount: 0, hasCompaction: 0, sourceType: "codex" });
    insertTurn(db, { sessionId: "codex-sess-1", turnIndex: 1, startedAt: "2026-04-10T14:10:00.000Z", inputTokens: 1200, outputTokens: 600, cacheRead: 0, cacheCreation: 0, costUsd: 0.012, modelFamily: "gpt-4.1", errorCount: 1, hasCompaction: 0, sourceType: "codex" });
    insertCommit(db, "codex-sess-1", 1);

    const result = mod.materializeSessionSummary("codex-sess-1");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("codex");
    expect(result!.projectPath).toBe("/tmp/codex-project");
    expect(result!.startedAt).toBe("2026-04-10T14:00:01.000Z");
    expect(result!.totalTurns).toBe(2);
    expect(result!.totalInputTokens).toBe(2000);
    expect(result!.totalOutputTokens).toBe(1000);
    expect(result!.totalCacheReadTokens).toBe(100);
    expect(result!.totalCacheCreationTokens).toBe(20);
    expect(result!.totalCostUsd).toBeCloseTo(0.02);
    expect(result!.totalCommits).toBe(1);
    expect(result!.totalErrors).toBe(1);
    expect(result!.isPartial).toBe(0);

    // Verify model costs for Codex model family
    const costs = mod.listSessionModelCosts("codex-sess-1");
    expect(costs).toHaveLength(1);
    expect(costs[0].modelFamily).toBe("gpt-4.1");
    expect(costs[0].turnCount).toBe(2);

    // Verify materializePendingSummaries picks up Codex sessions
    const stored = mod.getSessionSummary("codex-sess-1");
    expect(stored).not.toBeNull();
    expect(stored!.provider).toBe("codex");
  });

  it("uses started_at from first turn, not sessions.created_at", async () => {
    const mod = await setup();
    const db = mod.getDb();

    // created_at is discovery time (earlier), first turn is actual activity start
    insertSession(db, {
      id: "sess-timing",
      sourceType: "claude",
      projectPath: "/tmp/timing",
      createdAt: "2026-04-10T09:00:00.000Z",
      endedAt: "2026-04-10T12:00:00.000Z",
    });
    insertTurn(db, { sessionId: "sess-timing", turnIndex: 0, startedAt: "2026-04-10T10:00:00.000Z", inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    const result = mod.materializeSessionSummary("sess-timing");
    expect(result).not.toBeNull();
    // Should use turn timestamp, not session created_at
    expect(result!.startedAt).toBe("2026-04-10T10:00:00.000Z");
    // Duration from first turn to ended_at = 2 hours
    expect(result!.durationMs).toBe(2 * 60 * 60 * 1000);
  });
});

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-session-summaries-"));
  tempRoots.push(root);
  return root;
}

async function setup(): Promise<LoadedModules> {
  const root = createFixtureRoot();
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "session-summaries-test";
  vi.resetModules();

  const dbMod = await import("./db.js");
  const summaries = await import("./session-summaries.js");

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
    materializeSessionSummary: summaries.materializeSessionSummary,
    materializePendingSummaries: summaries.materializePendingSummaries,
    getSessionSummary: summaries.getSessionSummary,
    listSessionModelCosts: summaries.listSessionModelCosts,
  };
}

function insertSession(
  db: SqliteDatabase,
  opts: {
    id: string;
    sourceType: string;
    projectPath: string;
    createdAt: string;
    endedAt?: string;
    gitBranch?: string;
    status?: string;
  },
): void {
  db.prepare(`
    INSERT INTO sessions(id, source_type, project_path, cwd, git_branch, created_at, last_event_at, ended_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.sourceType,
    opts.projectPath,
    opts.projectPath,
    opts.gitBranch ?? null,
    opts.createdAt,
    opts.endedAt ?? opts.createdAt,
    opts.endedAt ?? null,
    opts.status ?? (opts.endedAt ? "ended" : "discovered"),
  );
}

function insertTurn(
  db: SqliteDatabase,
  opts: {
    sessionId: string;
    turnIndex: number;
    startedAt?: string;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreation: number;
    costUsd: number;
    modelFamily: string;
    errorCount: number;
    hasCompaction: number;
    sourceType?: string;
  },
): void {
  db.prepare(`
    INSERT INTO turns(
      session_id, turn_index, started_at, start_line, end_line,
      category, summary, user_instruction, assistant_preview, sections_json,
      input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      cost_usd, model_family, error_count, has_compaction, source_type
    )
    VALUES (?, ?, ?, 0, 10, 'conversation', '', '', '', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.sessionId,
    opts.turnIndex,
    opts.startedAt ?? "2026-04-10T10:00:00.000Z",
    opts.inputTokens,
    opts.outputTokens,
    opts.cacheRead,
    opts.cacheCreation,
    opts.costUsd,
    opts.modelFamily,
    opts.errorCount,
    opts.hasCompaction,
    opts.sourceType ?? "claude",
  );
}

function insertCommit(db: SqliteDatabase, sessionId: string, turnIndex: number): void {
  db.prepare(`
    INSERT INTO commits(session_id, turn_index, line_number, commit_message, timestamp)
    VALUES (?, ?, 0, 'test commit', '2026-04-10T10:00:00.000Z')
  `).run(sessionId, turnIndex);
}

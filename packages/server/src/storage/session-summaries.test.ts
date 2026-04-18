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
  enrichSessionSummary: (sessionId: string) => void;
  enrichPendingSummaries: () => number;
  classifyPendingSummaries: () => number;
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

// ─── Enrichment Tests ───────────────────────────────────────────────────────

describe("session summary enrichment", () => {
  it("populates tools_used from tool_calls", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "enrich-tools", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    insertTurn(db, { sessionId: "enrich-tools", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    insertTurn(db, { sessionId: "enrich-tools", turnIndex: 1, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    insertToolCall(db, { sessionId: "enrich-tools", turnIndex: 0, toolName: "Edit" });
    insertToolCall(db, { sessionId: "enrich-tools", turnIndex: 0, toolName: "Edit" });
    insertToolCall(db, { sessionId: "enrich-tools", turnIndex: 1, toolName: "Bash" });
    insertToolCall(db, { sessionId: "enrich-tools", turnIndex: 1, toolName: "Read" });

    mod.materializeSessionSummary("enrich-tools");
    mod.enrichSessionSummary("enrich-tools");

    const summary = mod.getSessionSummary("enrich-tools");
    expect(summary).not.toBeNull();
    const toolsUsed = JSON.parse(summary!.toolsUsed!);
    expect(toolsUsed).toEqual({ Edit: 2, Bash: 1, Read: 1 });
  });

  it("populates files_changed from file_touches (write/edit only)", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "enrich-files", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    insertTurn(db, { sessionId: "enrich-files", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    insertFileTouch(db, { sessionId: "enrich-files", turnIndex: 0, filePath: "src/app.ts", action: "write" });
    insertFileTouch(db, { sessionId: "enrich-files", turnIndex: 0, filePath: "src/app.ts", action: "edit" });
    insertFileTouch(db, { sessionId: "enrich-files", turnIndex: 0, filePath: "src/utils.ts", action: "edit" });
    insertFileTouch(db, { sessionId: "enrich-files", turnIndex: 0, filePath: "src/readme.md", action: "read" }); // should be excluded

    mod.materializeSessionSummary("enrich-files");
    mod.enrichSessionSummary("enrich-files");

    const summary = mod.getSessionSummary("enrich-files");
    expect(summary).not.toBeNull();
    const filesChanged = JSON.parse(summary!.filesChanged!);
    expect(filesChanged).toHaveLength(2);
    expect(filesChanged).toContain("src/app.ts");
    expect(filesChanged).toContain("src/utils.ts");
    expect(filesChanged).not.toContain("src/readme.md");
  });

  it("populates plans_created and plans_completed from plan_items", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "enrich-plans", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    for (let i = 0; i < 6; i++) {
      insertTurn(db, { sessionId: "enrich-plans", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    }

    // Turn 0: plan 1 drafted
    insertPlanItem(db, { sessionId: "enrich-plans", turnIndex: 0, source: "plan_markdown", subject: "Implement auth feature", status: "planned" });
    // Turn 1: 2 tasks created for plan 1
    insertPlanItem(db, { sessionId: "enrich-plans", turnIndex: 1, source: "task_create", subject: "Add login endpoint", status: "created", taskId: "task-1" });
    insertPlanItem(db, { sessionId: "enrich-plans", turnIndex: 1, source: "task_create", subject: "Add signup endpoint", status: "created", taskId: "task-2" });

    // Turn 2: plan 2 drafted
    insertPlanItem(db, { sessionId: "enrich-plans", turnIndex: 2, source: "plan_markdown", subject: "Refactor database layer", status: "planned" });
    // Turn 3: 1 task created for plan 2
    insertPlanItem(db, { sessionId: "enrich-plans", turnIndex: 3, source: "task_create", subject: "Migrate schema", status: "created", taskId: "task-3" });

    // Turn 4: both plan-1 tasks completed
    insertPlanItem(db, { sessionId: "enrich-plans", turnIndex: 4, source: "task_update", subject: "Task task-1", status: "completed", taskId: "task-1" });
    insertPlanItem(db, { sessionId: "enrich-plans", turnIndex: 4, source: "task_update", subject: "Task task-2", status: "completed", taskId: "task-2" });

    // Turn 5: plan-2 task still in progress (not completed)
    insertPlanItem(db, { sessionId: "enrich-plans", turnIndex: 5, source: "task_update", subject: "Task task-3", status: "in_progress", taskId: "task-3" });

    mod.materializeSessionSummary("enrich-plans");
    mod.enrichSessionSummary("enrich-plans");

    const summary = mod.getSessionSummary("enrich-plans");
    expect(summary).not.toBeNull();
    // 2 plan_markdown rows = 2 plans drafted
    expect(summary!.plansCreated).toBe(2);
    // Plan 1: task-1 + task-2 both completed → 1 completed plan
    // Plan 2: task-3 still in_progress → not completed
    expect(summary!.plansCompleted).toBe(1);
  });

  it("detects spinning and sets risk_peak", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "enrich-risk", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    // 5 consecutive error turns → error_loop critical + stuck critical
    for (let i = 0; i < 5; i++) {
      insertTurn(db, { sessionId: "enrich-risk", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 1, hasCompaction: 0, hasError: 1 });
      insertError(db, { sessionId: "enrich-risk", turnIndex: i, toolName: "Bash", message: "command failed" });
    }

    mod.materializeSessionSummary("enrich-risk");
    mod.enrichSessionSummary("enrich-risk");

    const summary = mod.getSessionSummary("enrich-risk");
    expect(summary).not.toBeNull();
    expect(summary!.hadSpinning).toBe(1);
    expect(summary!.riskPeak).toBe("critical");
    const spinningTypes = JSON.parse(summary!.spinningTypes!);
    expect(spinningTypes).toContain("error_loop");
  });

  it("sets operator to self when no operator config exists", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "enrich-op", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    insertTurn(db, { sessionId: "enrich-op", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    mod.materializeSessionSummary("enrich-op");
    mod.enrichSessionSummary("enrich-op");

    const summary = mod.getSessionSummary("enrich-op");
    expect(summary).not.toBeNull();
    expect(summary!.operatorId).toBe("self");
    expect(summary!.operatorName).toBeTruthy();
  });

  it("populates workstream_id from workstream_sessions", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "enrich-ws", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    insertTurn(db, { sessionId: "enrich-ws", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    insertWorkstreamSession(db, { workstreamId: "ws-auth-feature", sessionId: "enrich-ws", confidence: 0.95 });

    mod.materializeSessionSummary("enrich-ws");
    mod.enrichSessionSummary("enrich-ws");

    const summary = mod.getSessionSummary("enrich-ws");
    expect(summary).not.toBeNull();
    expect(summary!.workstreamId).toBe("ws-auth-feature");
  });

  it("handles session with no enrichment data gracefully", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "enrich-empty", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    insertTurn(db, { sessionId: "enrich-empty", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    mod.materializeSessionSummary("enrich-empty");
    mod.enrichSessionSummary("enrich-empty");

    const summary = mod.getSessionSummary("enrich-empty");
    expect(summary).not.toBeNull();
    expect(JSON.parse(summary!.toolsUsed!)).toEqual({});
    expect(JSON.parse(summary!.filesChanged!)).toEqual([]);
    expect(summary!.plansCreated).toBe(0);
    expect(summary!.plansCompleted).toBe(0);
    expect(summary!.riskPeak).toBe("nominal");
    expect(summary!.hadSpinning).toBe(0);
    expect(summary!.spinningTypes).toBeNull();
    expect(summary!.workstreamId).toBeNull();
  });

  it("enriching twice is idempotent", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "enrich-idem", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    insertTurn(db, { sessionId: "enrich-idem", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    insertToolCall(db, { sessionId: "enrich-idem", turnIndex: 0, toolName: "Edit" });
    insertFileTouch(db, { sessionId: "enrich-idem", turnIndex: 0, filePath: "src/app.ts", action: "write" });

    mod.materializeSessionSummary("enrich-idem");
    mod.enrichSessionSummary("enrich-idem");

    const first = mod.getSessionSummary("enrich-idem");
    mod.enrichSessionSummary("enrich-idem");
    const second = mod.getSessionSummary("enrich-idem");

    expect(first!.toolsUsed).toBe(second!.toolsUsed);
    expect(first!.filesChanged).toBe(second!.filesChanged);
    expect(first!.riskPeak).toBe(second!.riskPeak);
    expect(first!.operatorId).toBe(second!.operatorId);
  });

  it("enrichPendingSummaries backfills unenriched summaries", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "backfill-1", sourceType: "claude", projectPath: "/tmp/p1", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z", status: "ended" });
    insertTurn(db, { sessionId: "backfill-1", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    insertToolCall(db, { sessionId: "backfill-1", turnIndex: 0, toolName: "Bash" });

    insertSession(db, { id: "backfill-2", sourceType: "claude", projectPath: "/tmp/p2", createdAt: "2026-04-10T12:00:00.000Z", endedAt: "2026-04-10T13:00:00.000Z", status: "ended" });
    insertTurn(db, { sessionId: "backfill-2", turnIndex: 0, inputTokens: 200, outputTokens: 100, cacheRead: 0, cacheCreation: 0, costUsd: 0.002, modelFamily: "opus", errorCount: 0, hasCompaction: 0 });
    insertToolCall(db, { sessionId: "backfill-2", turnIndex: 0, toolName: "Read" });

    // Materialize without enriching
    mod.materializeSessionSummary("backfill-1");
    mod.materializeSessionSummary("backfill-2");

    // Verify they are unenriched
    expect(mod.getSessionSummary("backfill-1")!.toolsUsed).toBeNull();
    expect(mod.getSessionSummary("backfill-2")!.toolsUsed).toBeNull();

    // Backfill
    const count = mod.enrichPendingSummaries();
    expect(count).toBe(2);

    // Verify enriched
    const s1 = mod.getSessionSummary("backfill-1");
    expect(s1!.toolsUsed).not.toBeNull();
    expect(JSON.parse(s1!.toolsUsed!)).toEqual({ Bash: 1 });

    const s2 = mod.getSessionSummary("backfill-2");
    expect(s2!.toolsUsed).not.toBeNull();
    expect(JSON.parse(s2!.toolsUsed!)).toEqual({ Read: 1 });

    // Running again should find 0 pending
    const count2 = mod.enrichPendingSummaries();
    expect(count2).toBe(0);
  });
});

// ─── Outcome Classification Tests ───────────────────────────────────────────

describe("session outcome classification", () => {
  it("classifies productive session with commits", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "cls-prod", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    for (let i = 0; i < 5; i++) {
      insertTurn(db, { sessionId: "cls-prod", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    }
    insertToolCall(db, { sessionId: "cls-prod", turnIndex: 0, toolName: "Read" });
    insertToolCall(db, { sessionId: "cls-prod", turnIndex: 1, toolName: "Edit" });
    insertCommit(db, "cls-prod", 2);

    mod.materializeSessionSummary("cls-prod");
    mod.enrichSessionSummary("cls-prod");

    const summary = mod.getSessionSummary("cls-prod");
    expect(summary).not.toBeNull();
    expect(summary!.outcome).toBe("productive");
    expect(summary!.isDeadEnd).toBe(0);
    expect(summary!.deadEndReason).toBeNull();
  });

  it("classifies research session (read-heavy, no commits)", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "cls-research", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    for (let i = 0; i < 5; i++) {
      insertTurn(db, { sessionId: "cls-research", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    }
    // Majority read-only tools
    for (let i = 0; i < 5; i++) {
      insertToolCall(db, { sessionId: "cls-research", turnIndex: i, toolName: "Read" });
      insertToolCall(db, { sessionId: "cls-research", turnIndex: i, toolName: "Grep" });
    }
    insertToolCall(db, { sessionId: "cls-research", turnIndex: 2, toolName: "Bash" });

    mod.materializeSessionSummary("cls-research");
    mod.enrichSessionSummary("cls-research");

    const summary = mod.getSessionSummary("cls-research");
    expect(summary).not.toBeNull();
    expect(summary!.outcome).toBe("research");
    expect(summary!.isDeadEnd).toBe(0);
  });

  it("classifies dead-end spinning session", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "cls-spin", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    // 5 consecutive error turns triggers spinning detection
    for (let i = 0; i < 5; i++) {
      insertTurn(db, { sessionId: "cls-spin", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 1, hasCompaction: 0, hasError: 1 });
      insertError(db, { sessionId: "cls-spin", turnIndex: i, toolName: "Bash", message: "command failed" });
      insertToolCall(db, { sessionId: "cls-spin", turnIndex: i, toolName: "Bash" });
    }

    mod.materializeSessionSummary("cls-spin");
    mod.enrichSessionSummary("cls-spin");

    const summary = mod.getSessionSummary("cls-spin");
    expect(summary).not.toBeNull();
    expect(summary!.outcome).toBe("dead_end:spinning");
    expect(summary!.isDeadEnd).toBe(1);
    expect(summary!.deadEndReason).toBe("dead_end:spinning");
  });

  it("classifies dead-end abandoned session (10+ turns, no commits, not research)", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "cls-abandon", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    for (let i = 0; i < 12; i++) {
      insertTurn(db, { sessionId: "cls-abandon", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
      // Mix of write and read tools — not majority read-only
      insertToolCall(db, { sessionId: "cls-abandon", turnIndex: i, toolName: i % 2 === 0 ? "Edit" : "Bash" });
      insertToolCall(db, { sessionId: "cls-abandon", turnIndex: i, toolName: "Read" });
    }

    mod.materializeSessionSummary("cls-abandon");
    mod.enrichSessionSummary("cls-abandon");

    const summary = mod.getSessionSummary("cls-abandon");
    expect(summary).not.toBeNull();
    expect(summary!.outcome).toBe("dead_end:abandoned");
    expect(summary!.isDeadEnd).toBe(1);
    expect(summary!.deadEndReason).toBe("dead_end:abandoned");
  });

  it("classifies abandoned_start session (< 3 turns, no commits)", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "cls-short", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T10:05:00.000Z" });
    insertTurn(db, { sessionId: "cls-short", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    insertTurn(db, { sessionId: "cls-short", turnIndex: 1, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    mod.materializeSessionSummary("cls-short");
    mod.enrichSessionSummary("cls-short");

    const summary = mod.getSessionSummary("cls-short");
    expect(summary).not.toBeNull();
    expect(summary!.outcome).toBe("abandoned_start");
    expect(summary!.isDeadEnd).toBe(0);
  });

  it("classifies push-only session as productive (0 commits, is_git_push = 1)", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "cls-push", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    for (let i = 0; i < 4; i++) {
      insertTurn(db, { sessionId: "cls-push", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
      insertToolCall(db, { sessionId: "cls-push", turnIndex: i, toolName: "Bash" });
    }
    insertCommand(db, { sessionId: "cls-push", turnIndex: 2, commandText: "git push origin main", isGitPush: 1 });

    mod.materializeSessionSummary("cls-push");
    mod.enrichSessionSummary("cls-push");

    const summary = mod.getSessionSummary("cls-push");
    expect(summary).not.toBeNull();
    expect(summary!.outcome).toBe("productive");
    expect(summary!.isDeadEnd).toBe(0);
  });

  it("classifies productive via turns.has_push = 1 (no commits, no commands)", async () => {
    const mod = await setup();
    const db = mod.getDb();

    insertSession(db, { id: "cls-tpush", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z" });
    for (let i = 0; i < 4; i++) {
      insertTurn(db, { sessionId: "cls-tpush", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0, hasPush: i === 2 ? 1 : 0 });
      insertToolCall(db, { sessionId: "cls-tpush", turnIndex: i, toolName: "Bash" });
    }
    // No commits, no commands with is_git_push — only turns.has_push

    mod.materializeSessionSummary("cls-tpush");
    mod.enrichSessionSummary("cls-tpush");

    const summary = mod.getSessionSummary("cls-tpush");
    expect(summary).not.toBeNull();
    expect(summary!.outcome).toBe("productive");
    expect(summary!.isDeadEnd).toBe(0);
  });

  it("backfills previously-unclassified summaries via classifyPendingSummaries", async () => {
    const mod = await setup();
    const db = mod.getDb();

    // Session 1: productive (has commits)
    insertSession(db, { id: "bf-1", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T10:00:00.000Z", endedAt: "2026-04-10T11:00:00.000Z", status: "ended" });
    for (let i = 0; i < 3; i++) {
      insertTurn(db, { sessionId: "bf-1", turnIndex: i, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    }
    insertToolCall(db, { sessionId: "bf-1", turnIndex: 0, toolName: "Edit" });
    insertCommit(db, "bf-1", 1);

    // Session 2: abandoned start (2 turns, no commits)
    insertSession(db, { id: "bf-2", sourceType: "claude", projectPath: "/tmp/p", createdAt: "2026-04-10T12:00:00.000Z", endedAt: "2026-04-10T12:05:00.000Z", status: "ended" });
    insertTurn(db, { sessionId: "bf-2", turnIndex: 0, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });
    insertTurn(db, { sessionId: "bf-2", turnIndex: 1, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreation: 0, costUsd: 0.001, modelFamily: "sonnet", errorCount: 0, hasCompaction: 0 });

    // Materialize + enrich both
    mod.materializeSessionSummary("bf-1");
    mod.materializeSessionSummary("bf-2");
    mod.enrichSessionSummary("bf-1");
    mod.enrichSessionSummary("bf-2");

    // Verify they got classified via enrichment
    expect(mod.getSessionSummary("bf-1")!.outcome).toBe("productive");
    expect(mod.getSessionSummary("bf-2")!.outcome).toBe("abandoned_start");

    // Manually reset to 'unknown' to simulate pre-existing unclassified rows
    db.prepare(`UPDATE session_summaries SET outcome = 'unknown', is_dead_end = 0, dead_end_reason = NULL WHERE session_id IN ('bf-1', 'bf-2')`).run();
    expect(mod.getSessionSummary("bf-1")!.outcome).toBe("unknown");
    expect(mod.getSessionSummary("bf-2")!.outcome).toBe("unknown");

    // Backfill
    const count = mod.classifyPendingSummaries();
    expect(count).toBe(2);

    // Verify reclassified
    expect(mod.getSessionSummary("bf-1")!.outcome).toBe("productive");
    expect(mod.getSessionSummary("bf-2")!.outcome).toBe("abandoned_start");

    // Running again should find 0 pending
    const count2 = mod.classifyPendingSummaries();
    expect(count2).toBe(0);
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
    enrichSessionSummary: summaries.enrichSessionSummary,
    enrichPendingSummaries: summaries.enrichPendingSummaries,
    classifyPendingSummaries: summaries.classifyPendingSummaries,
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
    hasError?: number;
    hasPlanStart?: number;
    hasPlanEnd?: number;
    hasPush?: number;
  },
): void {
  db.prepare(`
    INSERT INTO turns(
      session_id, turn_index, started_at, start_line, end_line,
      category, summary, user_instruction, assistant_preview, sections_json,
      input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      cost_usd, model_family, error_count, has_compaction, source_type,
      has_error, has_plan_start, has_plan_end, has_push
    )
    VALUES (?, ?, ?, 0, 10, 'conversation', '', '', '', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    opts.hasError ?? (opts.errorCount > 0 ? 1 : 0),
    opts.hasPlanStart ?? 0,
    opts.hasPlanEnd ?? 0,
    opts.hasPush ?? 0,
  );
}

function insertCommit(db: SqliteDatabase, sessionId: string, turnIndex: number): void {
  db.prepare(`
    INSERT INTO commits(session_id, turn_index, line_number, commit_message, timestamp)
    VALUES (?, ?, 0, 'test commit', '2026-04-10T10:00:00.000Z')
  `).run(sessionId, turnIndex);
}

function insertToolCall(
  db: SqliteDatabase,
  opts: { sessionId: string; turnIndex: number; toolName: string; inputJson?: string },
): void {
  db.prepare(`
    INSERT INTO tool_calls(session_id, turn_index, line_number, call_id, tool_name, input_json)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(
    opts.sessionId,
    opts.turnIndex,
    crypto.randomUUID(),
    opts.toolName,
    opts.inputJson ?? "{}",
  );
}

function insertFileTouch(
  db: SqliteDatabase,
  opts: { sessionId: string; turnIndex: number; filePath: string; action: string; sourceTool?: string },
): void {
  db.prepare(`
    INSERT INTO file_touches(session_id, turn_index, line_number, file_path, action, source_tool)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(opts.sessionId, opts.turnIndex, opts.filePath, opts.action, opts.sourceTool ?? "Edit");
}

function insertError(
  db: SqliteDatabase,
  opts: { sessionId: string; turnIndex: number; toolName: string; message: string },
): void {
  db.prepare(`
    INSERT INTO errors(session_id, turn_index, line_number, tool_name, message)
    VALUES (?, ?, 0, ?, ?)
  `).run(opts.sessionId, opts.turnIndex, opts.toolName, opts.message);
}

function insertCommand(
  db: SqliteDatabase,
  opts: { sessionId: string; turnIndex: number; commandText: string; isGitCommit?: number; isGitPush?: number },
): void {
  db.prepare(`
    INSERT INTO commands(session_id, turn_index, line_number, tool_call_id, command_text, is_git_commit, is_git_push)
    VALUES (?, ?, 0, ?, ?, ?, ?)
  `).run(opts.sessionId, opts.turnIndex, crypto.randomUUID(), opts.commandText, opts.isGitCommit ?? 0, opts.isGitPush ?? 0);
}

function insertPlanItem(
  db: SqliteDatabase,
  opts: { sessionId: string; turnIndex: number; source?: string; subject: string; status?: string; taskId?: string },
): void {
  db.prepare(`
    INSERT INTO plan_items(session_id, turn_index, line_number, source, task_id, subject, status)
    VALUES (?, ?, 0, ?, ?, ?, ?)
  `).run(opts.sessionId, opts.turnIndex, opts.source ?? "plan_markdown", opts.taskId ?? null, opts.subject, opts.status ?? null);
}

function insertWorkstreamSession(
  db: SqliteDatabase,
  opts: { workstreamId: string; sessionId: string; confidence?: number },
): void {
  // Ensure workstream exists
  db.prepare(`
    INSERT OR IGNORE INTO workstreams(id, project_path, canonical_key, title, status, confidence, created_at, updated_at)
    VALUES (?, '/tmp/p', ?, ?, 'active', 1.0, datetime('now'), datetime('now'))
  `).run(opts.workstreamId, opts.workstreamId, opts.workstreamId);

  db.prepare(`
    INSERT INTO workstream_sessions(workstream_id, session_id, relationship_type, confidence, derived_at)
    VALUES (?, ?, 'branch', ?, datetime('now'))
  `).run(opts.workstreamId, opts.sessionId, opts.confidence ?? 0.9);
}

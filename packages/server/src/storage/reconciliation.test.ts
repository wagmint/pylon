import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempRoots: string[] = [];
const storageClosers: Array<() => void> = [];
const originalHome = process.env.HOME;

afterEach(() => {
  for (const close of storageClosers.splice(0)) {
    close();
  }
  delete process.env.HEXDECK_HOME_DIR;
  delete process.env.HEXDECK_CLAUDE_DIR;
  delete process.env.HEXDECK_STORAGE_PARSER_VERSION;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("session lifecycle reconciliation", () => {
  it("marks stale Claude sessions as ended with end_reason='stale'", async () => {
    const root = createFixtureRoot();
    const transcriptPath = createClaudeTranscript(root, {
      sessionId: "stale-session",
      projectPath: "/tmp/stale-project",
      lines: [
        messageLine("2026-04-14T10:00:00.000Z", "user", "Start the task"),
        messageLine("2026-04-14T10:00:05.000Z", "assistant", "Working on it"),
      ],
    });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(transcriptPath, twoDaysAgo, twoDaysAgo);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    vi.spyOn(mod.claudeAdapter, "getActiveSessions").mockResolvedValue([]);
    vi.spyOn(mod.codexAdapter, "getActiveSessions").mockResolvedValue([]);

    await mod.reconcileSessionLifecycles();

    const stored = mod.listStoredSessions("claude");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: "stale-session",
      status: "ended",
      endReason: "stale",
    });
    expect(stored[0].endedAt).not.toBeNull();
  });

  it("refreshes last_event_at from latest turn when session is still active", async () => {
    const root = createFixtureRoot();
    createClaudeTranscript(root, {
      sessionId: "active-session",
      projectPath: "/tmp/active-project",
      lines: [
        messageLine("2026-04-15T10:00:00.000Z", "user", "Start"),
        messageLine("2026-04-15T10:00:05.000Z", "assistant", "Done"),
      ],
    });

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const db = mod.getDb();
    const beforeRow = db
      .prepare(`SELECT last_event_at, status FROM sessions WHERE id = ?`)
      .get("active-session") as { last_event_at: string; status: string };

    const newerTimestamp = "2030-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO turns(
        session_id, turn_index, started_at, start_line, end_line,
        category, summary, user_instruction, assistant_preview, sections_json, source_type
      ) VALUES (?, 99, ?, 0, 0, 'conversation', '', '', '', '[]', 'claude')`,
    ).run("active-session", newerTimestamp);

    const activeRef = {
      id: "active-session",
      path: "/ignored",
      projectPath: "/tmp/active-project",
      createdAt: new Date(),
      modifiedAt: new Date(),
      sizeBytes: 0,
      provider: "claude" as const,
      sourcePath: "/ignored",
      sourceMtime: new Date(),
      sourceSizeBytes: 0,
    };
    vi.spyOn(mod.claudeAdapter, "getActiveSessions").mockResolvedValue([activeRef]);
    vi.spyOn(mod.codexAdapter, "getActiveSessions").mockResolvedValue([]);

    await mod.reconcileSessionLifecycles();

    const afterRow = db
      .prepare(`SELECT last_event_at, status FROM sessions WHERE id = ?`)
      .get("active-session") as { last_event_at: string; status: string };

    expect(afterRow.last_event_at).toBe(newerTimestamp);
    expect(afterRow.status).toBe(beforeRow.status);
    expect(afterRow.status).not.toBe("ended");
  });

  it("finalizes inactive-but-recent sessions as process_gone using last_event_at", async () => {
    const root = createFixtureRoot();
    createClaudeTranscript(root, {
      sessionId: "recent-gone",
      projectPath: "/tmp/recent-gone-project",
      lines: [
        messageLine("2026-04-16T10:00:00.000Z", "user", "hi"),
        messageLine("2026-04-16T10:00:05.000Z", "assistant", "hello"),
      ],
    });

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const db = mod.getDb();
    const beforeRow = db
      .prepare(`SELECT last_event_at FROM sessions WHERE id = ?`)
      .get("recent-gone") as { last_event_at: string };

    vi.spyOn(mod.claudeAdapter, "getActiveSessions").mockResolvedValue([]);
    vi.spyOn(mod.codexAdapter, "getActiveSessions").mockResolvedValue([]);

    await mod.reconcileSessionLifecycles();

    const row = mod.listStoredSessions("claude")[0];
    expect(row).toMatchObject({
      id: "recent-gone",
      status: "ended",
      endReason: "process_gone",
      endedAt: beforeRow.last_event_at,
    });

    // Reconciliation should also materialize a session summary
    const summary = mod.getSessionSummary("recent-gone");
    expect(summary).not.toBeNull();
    expect(summary!.sessionId).toBe("recent-gone");
    expect(summary!.provider).toBe("claude");
    expect(summary!.isPartial).toBe(0);
    expect(summary!.endedAt).toBe(beforeRow.last_event_at);
    expect(summary!.totalTurns).toBeGreaterThanOrEqual(0);

    // Model costs should exist (empty is fine if no model_family on turns)
    const costs = mod.listSessionModelCosts("recent-gone");
    expect(Array.isArray(costs)).toBe(true);
  });

  it("skips a provider when getActiveSessions fails, leaving its sessions untouched", async () => {
    const root = createFixtureRoot();
    const transcriptPath = createClaudeTranscript(root, {
      sessionId: "live-session",
      projectPath: "/tmp/live-project",
      lines: [messageLine("2026-04-16T10:00:00.000Z", "user", "hi")],
    });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(transcriptPath, twoDaysAgo, twoDaysAgo);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    vi.spyOn(mod.claudeAdapter, "getActiveSessions").mockRejectedValue(
      new Error("pgrep exploded"),
    );
    vi.spyOn(mod.codexAdapter, "getActiveSessions").mockResolvedValue([]);

    await mod.reconcileSessionLifecycles();

    const row = mod.listStoredSessions("claude")[0];
    expect(row.status).not.toBe("ended");
    expect(row.endReason).toBeNull();
  });

  it("is idempotent when a session is already ended", async () => {
    const root = createFixtureRoot();
    const transcriptPath = createClaudeTranscript(root, {
      sessionId: "already-ended",
      projectPath: "/tmp/ended-project",
      lines: [messageLine("2026-04-10T10:00:00.000Z", "user", "done")],
    });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(transcriptPath, twoDaysAgo, twoDaysAgo);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const db = mod.getDb();
    const fixedEndedAt = "2026-04-10T11:00:00.000Z";
    db.prepare(
      `UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = 'explicit_shutdown' WHERE id = ?`,
    ).run(fixedEndedAt, "already-ended");

    vi.spyOn(mod.claudeAdapter, "getActiveSessions").mockResolvedValue([]);
    vi.spyOn(mod.codexAdapter, "getActiveSessions").mockResolvedValue([]);

    await mod.reconcileSessionLifecycles();
    await mod.reconcileSessionLifecycles();

    const row = mod.listStoredSessions("claude")[0];
    expect(row).toMatchObject({
      id: "already-ended",
      status: "ended",
      endedAt: fixedEndedAt,
      endReason: "explicit_shutdown",
    });
  });

  it("detects Codex shutdown events and writes end_reason='explicit_shutdown'", async () => {
    const root = createFixtureRoot();
    const rolloutPath = createCodexShutdownRollout(root, "codex-shutdown");

    const mod = await loadModules(root);
    await mod.initStorage();
    await mod.syncSessionsToStorage(mod.codexAdapter);

    vi.spyOn(mod.claudeAdapter, "getActiveSessions").mockResolvedValue([]);
    vi.spyOn(mod.codexAdapter, "getActiveSessions").mockResolvedValue([]);

    await mod.reconcileSessionLifecycles();

    const rows = mod.listStoredSessions("codex");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "codex-shutdown",
      status: "ended",
      endReason: "explicit_shutdown",
      endedAt: "2026-04-17T14:00:10.000Z",
    });
    expect(statSync(rolloutPath).size).toBeGreaterThan(0);
  });

  it("reconcileOnStartup catches sessions that ended while hexdeck was offline", async () => {
    const root = createFixtureRoot();
    const transcriptPath = createClaudeTranscript(root, {
      sessionId: "offline-ended",
      projectPath: "/tmp/offline-project",
      lines: [messageLine("2026-04-01T10:00:00.000Z", "user", "hi")],
    });
    const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
    utimesSync(transcriptPath, threeDaysAgo, threeDaysAgo);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    vi.spyOn(mod.claudeAdapter, "getActiveSessions").mockResolvedValue([]);
    vi.spyOn(mod.codexAdapter, "getActiveSessions").mockResolvedValue([]);

    await mod.reconcileOnStartup();

    const row = mod.listStoredSessions("claude")[0];
    expect(row).toMatchObject({
      id: "offline-ended",
      status: "ended",
      endReason: "stale",
    });
  });

  it("upsertSession does not overwrite ended sessions", async () => {
    const root = createFixtureRoot();
    createClaudeTranscript(root, {
      sessionId: "guarded-session",
      projectPath: "/tmp/guarded-project",
      lines: [messageLine("2026-04-16T10:00:00.000Z", "user", "hi")],
    });

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const db = mod.getDb();
    const endedAt = "2026-04-16T12:00:00.000Z";
    db.prepare(
      `UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = 'stale' WHERE id = ?`,
    ).run(endedAt, "guarded-session");

    // Re-sync should not clobber ended state.
    mod.syncClaudeSessionsToStorage();

    const row = mod.listStoredSessions("claude")[0];
    expect(row).toMatchObject({
      id: "guarded-session",
      status: "ended",
      endedAt,
      endReason: "stale",
    });
  });

  it("getStoredSessionRef reconstructs a ProviderSessionRef for a synced session", async () => {
    const root = createFixtureRoot();
    const transcriptPath = createClaudeTranscript(root, {
      sessionId: "ref-roundtrip",
      projectPath: "/tmp/roundtrip-project",
      lines: [messageLine("2026-04-16T10:00:00.000Z", "user", "hi")],
    });

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const ref = mod.getStoredSessionRef("ref-roundtrip");
    expect(ref).not.toBeNull();
    expect(ref).toMatchObject({
      id: "ref-roundtrip",
      provider: "claude",
      path: transcriptPath,
      sourcePath: transcriptPath,
    });
    expect(ref?.createdAt).toBeInstanceOf(Date);
    expect(ref?.modifiedAt).toBeInstanceOf(Date);
    expect(ref?.sourceMtime).toBeInstanceOf(Date);
    expect(ref?.sizeBytes).toBeGreaterThan(0);
  });

  it("getStoredSessionRef returns null for unknown session ids", async () => {
    const root = createFixtureRoot();
    const mod = await loadModules(root);
    await mod.initStorage();
    expect(mod.getStoredSessionRef("does-not-exist")).toBeNull();
  });
});

interface LoadedModules {
  getDb: () => import("./sqlite.js").SqliteDatabase;
  closeStorage: () => void;
  initStorage: () => Promise<unknown>;
  listStoredSessions: (provider?: "claude" | "codex") => Array<{
    id: string;
    sourceType: string;
    status: string;
    endedAt: string | null;
    endReason: string | null;
  }>;
  syncClaudeSessionsToStorage: () => { projectCount: number; sessionCount: number };
  syncSessionsToStorage: (
    adapter: import("../providers/types.js").AgentProviderAdapter,
  ) => Promise<{ projectCount: number; sessionCount: number }>;
  reconcileSessionLifecycles: () => Promise<void>;
  reconcileOnStartup: () => Promise<void>;
  getStoredSessionRef: (
    sessionId: string,
  ) => import("../providers/types.js").ProviderSessionRef | null;
  getSessionSummary: (sessionId: string) => import("./session-summaries.js").SessionSummaryRow | null;
  listSessionModelCosts: (sessionId: string) => import("./session-summaries.js").SessionModelCostRow[];
  claudeAdapter: import("../providers/types.js").AgentProviderAdapter;
  codexAdapter: import("../providers/types.js").AgentProviderAdapter;
}

async function loadModules(root: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "reconciliation-test";
  process.env.HOME = root;
  vi.resetModules();

  const db = await import("./db.js");
  const repositories = await import("./repositories.js");
  const sync = await import("./sync.js");
  const reconciliation = await import("./reconciliation.js");
  const summaries = await import("./session-summaries.js");
  const providers = await import("../providers/index.js");

  storageClosers.push(() => {
    try {
      db.closeStorage();
    } catch {
      // Ignore cleanup failures in tests.
    }
  });

  return {
    getDb: db.getDb,
    closeStorage: db.closeStorage,
    initStorage: db.initStorage,
    listStoredSessions: repositories.listStoredSessions,
    syncClaudeSessionsToStorage: sync.syncClaudeSessionsToStorage,
    syncSessionsToStorage: sync.syncSessionsToStorage,
    reconcileSessionLifecycles: reconciliation.reconcileSessionLifecycles,
    reconcileOnStartup: reconciliation.reconcileOnStartup,
    getStoredSessionRef: repositories.getStoredSessionRef,
    getSessionSummary: summaries.getSessionSummary,
    listSessionModelCosts: summaries.listSessionModelCosts,
    claudeAdapter: providers.claudeAdapter,
    codexAdapter: providers.codexAdapter,
  };
}

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-reconciliation-"));
  tempRoots.push(root);
  return root;
}

function createClaudeTranscript(
  root: string,
  {
    sessionId,
    projectPath,
    lines,
  }: {
    sessionId: string;
    projectPath: string;
    lines: string[];
  },
): string {
  const projectsDir = join(root, ".claude", "projects");
  const encodedProjectPath = projectPath.replace(/[^a-zA-Z0-9-]/g, "-");
  const projectDir = join(projectsDir, encodedProjectPath);
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
  return transcriptPath;
}

function messageLine(timestamp: string, role: "user" | "assistant", text: string): string {
  return JSON.stringify({ timestamp, role, content: text });
}

function createCodexShutdownRollout(root: string, sessionId: string): string {
  const rolloutDir = join(root, ".codex", "sessions", "2026", "04", "17");
  mkdirSync(rolloutDir, { recursive: true });
  const rolloutPath = join(rolloutDir, `rollout-${sessionId}.jsonl`);
  const lines = [
    codexLine("2026-04-17T14:00:00.000Z", "session_meta", {
      id: sessionId,
      cwd: "/tmp/codex-shutdown-project",
      source: "codex",
      model: "gpt-5.4-codex",
    }),
    codexLine("2026-04-17T14:00:01.000Z", "event_msg", { type: "task_started" }),
    codexLine("2026-04-17T14:00:02.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "text", text: "Do the thing" }],
    }),
    codexLine("2026-04-17T14:00:09.000Z", "event_msg", { type: "task_complete" }),
    codexLine("2026-04-17T14:00:10.000Z", "event_msg", { type: "shutdown_complete" }),
  ];
  writeFileSync(rolloutPath, `${lines.join("\n")}\n`, "utf-8");
  return rolloutPath;
}

function codexLine(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface LoadedModules {
  closeStorage: () => void;
  initStorage: () => Promise<unknown>;
  listIngestionCheckpoints: () => Array<{
    parserVersion: string;
    lastProcessedLine: number;
    lastProcessedByteOffset: number;
    lastProcessedTimestamp: string | null;
    status: string;
  }>;
  listStoredClaudeSessions: () => Array<{ id: string; projectPath: string }>;
  listTranscriptSources: () => Array<{ sessionId: string; fileSizeBytes: number; isActive: boolean }>;
  syncClaudeSessionsToStorage: () => { projectCount: number; sessionCount: number };
}

const tempRoots: string[] = [];
const storageClosers: Array<() => void> = [];

afterEach(() => {
  for (const close of storageClosers.splice(0)) {
    close();
  }
  delete process.env.HEXDECK_HOME_DIR;
  delete process.env.HEXDECK_CLAUDE_DIR;
  delete process.env.HEXDECK_STORAGE_PARSER_VERSION;
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("storage sync foundation", () => {
  it("creates durable transcript sources, sessions, and checkpoints on first sync", async () => {
    const root = createFixtureRoot();
    const transcript = createClaudeTranscript(root, {
      sessionId: "session-a",
      projectPath: "/tmp/demo-project",
      lines: [
        messageLine("2026-04-05T10:00:00.000Z", "user", "Start the task"),
        messageLine("2026-04-05T10:00:05.000Z", "assistant", "Working on it"),
      ],
    });
    const mod = await loadModules(root, "m1-foundation-v1");

    const result = await mod.initStorage().then(() => mod.syncClaudeSessionsToStorage());

    expect(result).toEqual({ projectCount: 1, sessionCount: 1 });
    expect(mod.listStoredClaudeSessions()).toEqual([
      expect.objectContaining({
        id: "session-a",
        projectPath: "/tmp/demo/project",
      }),
    ]);
    expect(mod.listTranscriptSources()).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        fileSizeBytes: statSync(transcript).size,
        isActive: 1,
      }),
    ]);
    expect(mod.listIngestionCheckpoints()).toEqual([
      expect.objectContaining({
        parserVersion: "m1-foundation-v1",
        lastProcessedLine: 2,
        lastProcessedByteOffset: statSync(transcript).size,
        lastProcessedTimestamp: "2026-04-05T10:00:05.000Z",
        status: "ready",
      }),
    ]);
  });

  it("advances checkpoints incrementally when transcripts grow append-only", async () => {
    const root = createFixtureRoot();
    const transcript = createClaudeTranscript(root, {
      sessionId: "session-b",
      projectPath: "/tmp/incremental-project",
      lines: [
        messageLine("2026-04-05T11:00:00.000Z", "user", "First line"),
      ],
    });
    const mod = await loadModules(root, "m1-foundation-v1");

    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();
    const initialCheckpoint = mod.listIngestionCheckpoints()[0];

    appendFileSync(
      transcript,
      `${messageLine("2026-04-05T11:00:03.000Z", "assistant", "Second line")}\n`,
      "utf-8",
    );

    mod.syncClaudeSessionsToStorage();
    const updatedCheckpoint = mod.listIngestionCheckpoints()[0];

    expect(initialCheckpoint.lastProcessedLine).toBe(1);
    expect(updatedCheckpoint.lastProcessedLine).toBe(2);
    expect(updatedCheckpoint.lastProcessedByteOffset).toBe(statSync(transcript).size);
    expect(updatedCheckpoint.lastProcessedTimestamp).toBe("2026-04-05T11:00:03.000Z");
    expect(updatedCheckpoint.status).toBe("ready");
  });

  it("resets and reprocesses checkpoints when parser version changes", async () => {
    const root = createFixtureRoot();
    const transcript = createClaudeTranscript(root, {
      sessionId: "session-c",
      projectPath: "/tmp/reingest-project",
      lines: [
        messageLine("2026-04-05T12:00:00.000Z", "user", "Kick off"),
        messageLine("2026-04-05T12:00:02.000Z", "assistant", "Done"),
      ],
    });

    const initial = await loadModules(root, "m1-foundation-v1");
    await initial.initStorage();
    initial.syncClaudeSessionsToStorage();
    expect(initial.listIngestionCheckpoints()[0]).toEqual(
      expect.objectContaining({
        parserVersion: "m1-foundation-v1",
        lastProcessedLine: 2,
        lastProcessedByteOffset: statSync(transcript).size,
        status: "ready",
      }),
    );

    closeAllStorage();

    const reingested = await loadModules(root, "m1-foundation-v2");
    await reingested.initStorage();
    reingested.syncClaudeSessionsToStorage();
    expect(reingested.listIngestionCheckpoints()[0]).toEqual(
      expect.objectContaining({
        parserVersion: "m1-foundation-v2",
        lastProcessedLine: 2,
        lastProcessedByteOffset: statSync(transcript).size,
        status: "ready",
      }),
    );
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-storage-"));
  tempRoots.push(root);
  return root;
}

async function loadModules(root: string, parserVersion: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = parserVersion;
  vi.resetModules();

  const db = await import("./db.js");
  const repositories = await import("./repositories.js");
  const sync = await import("./sync.js");

  storageClosers.push(() => {
    try {
      db.closeStorage();
    } catch {
      // Ignore cleanup failures in tests.
    }
  });

  return {
    closeStorage: db.closeStorage,
    initStorage: db.initStorage,
    listIngestionCheckpoints: repositories.listIngestionCheckpoints,
    listStoredClaudeSessions: repositories.listStoredClaudeSessions,
    listTranscriptSources: repositories.listTranscriptSources,
    syncClaudeSessionsToStorage: sync.syncClaudeSessionsToStorage,
  };
}

function closeAllStorage(): void {
  for (const close of storageClosers.splice(0)) {
    close();
  }
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
  return JSON.stringify({
    timestamp,
    role,
    content: text,
  });
}

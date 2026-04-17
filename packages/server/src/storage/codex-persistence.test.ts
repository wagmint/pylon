import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProviderAdapter, ProviderSessionRef } from "../providers/types.js";
import { toProviderSessionRef } from "../providers/types.js";

interface LoadedModules {
  closeStorage: () => void;
  initStorage: () => Promise<unknown>;
  listIngestionCheckpoints: () => Array<{
    lastProcessedLine: number;
    lastProcessedByteOffset: number;
    lastProcessedTimestamp: string | null;
    status: string;
  }>;
  listStoredSessions: (provider?: "claude" | "codex") => Array<{
    id: string;
    sourceType: string;
    metadataJson: string | null;
  }>;
  listTranscriptSources: () => Array<{
    sourceType: string;
    sessionId: string;
    fileSizeBytes: number;
  }>;
  listStoredTurns: (sessionId?: string) => Array<{ sourceType: string; sessionId: string; turnIndex: number }>;
  listStoredEvents: (sessionId?: string) => Array<{ sourceType: string; sessionId: string; eventType: string }>;
  listStoredToolCalls: (sessionId?: string) => Array<{ toolName: string }>;
  listStoredFileTouches: (sessionId?: string) => Array<{ filePath: string | null; sourceTool: string }>;
  listStoredCommands: (sessionId?: string) => Array<{ commandText: string; isGitCommit: boolean }>;
  listStoredCommits: (sessionId?: string) => Array<{
    lineNumber: number;
    commandToolCallId: string | null;
    commitMessage: string | null;
    commitSha: string | null;
  }>;
  listStoredErrors: (sessionId?: string) => Array<{ toolName: string | null; message: string }>;
  syncSessionsToStorage: (adapter: AgentProviderAdapter) => Promise<{ projectCount: number; sessionCount: number }>;
}

const tempRoots: string[] = [];
const storageClosers: Array<() => void> = [];

afterEach(() => {
  for (const close of storageClosers.splice(0)) close();
  delete process.env.HEXDECK_HOME_DIR;
  delete process.env.HEXDECK_STORAGE_PARSER_VERSION;
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Codex storage persistence", () => {
  it("persists Codex canonical evidence through provider-neutral sync", async () => {
    const root = createFixtureRoot();
    const rolloutPath = createCodexRollout(root, "codex-session-a");
    const ref = makeCodexRef(rolloutPath);
    const parseCalls = { count: 0 };
    const adapter = makeCodexFixtureAdapter(ref, parseCalls);
    const mod = await loadModules(root);

    await mod.initStorage();
    const result = await mod.syncSessionsToStorage(adapter);

    expect(result).toEqual({ projectCount: 1, sessionCount: 1 });
    expect(mod.listTranscriptSources()).toEqual([
      expect.objectContaining({
        sourceType: "codex",
        sessionId: "codex-session-a",
        fileSizeBytes: statSync(rolloutPath).size,
      }),
    ]);
    expect(mod.listIngestionCheckpoints()).toEqual([
      expect.objectContaining({
        lastProcessedLine: 11,
        lastProcessedByteOffset: statSync(rolloutPath).size,
        lastProcessedTimestamp: "2026-04-17T14:00:10.000Z",
        status: "ready",
      }),
    ]);

    const sessions = mod.listStoredSessions("codex");
    expect(sessions).toEqual([
      expect.objectContaining({ id: "codex-session-a", sourceType: "codex" }),
    ]);
    let metadata = JSON.parse(sessions[0].metadataJson ?? "{}");
    expect(metadata.codexRuntime).toEqual(expect.objectContaining({
      lastEventType: "shutdown",
      lastEventAt: "2026-04-17T14:00:10.000Z",
      inTurn: false,
    }));

    expect(mod.listStoredTurns("codex-session-a")).toEqual([
      expect.objectContaining({ sourceType: "codex", sessionId: "codex-session-a", turnIndex: 0 }),
    ]);
    expect(mod.listStoredEvents("codex-session-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: "codex", eventType: "session_meta" }),
        expect.objectContaining({ sourceType: "codex", eventType: "turn_started" }),
        expect.objectContaining({ sourceType: "codex", eventType: "exec_command" }),
        expect.objectContaining({ sourceType: "codex", eventType: "patch_apply" }),
        expect.objectContaining({ sourceType: "codex", eventType: "shutdown" }),
      ]),
    );
    expect(mod.listStoredToolCalls("codex-session-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "exec_command" }),
        expect.objectContaining({ toolName: "patch_apply" }),
      ]),
    );
    expect(mod.listStoredCommands("codex-session-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commandText: "npm test", isGitCommit: 0 }),
        expect.objectContaining({ commandText: 'git commit -m "Codex persistence"', isGitCommit: 1 }),
      ]),
    );
    expect(mod.listStoredFileTouches("codex-session-a")).toEqual([
      expect.objectContaining({ filePath: "src/codex.ts", sourceTool: "patch_apply" }),
    ]);
    expect(mod.listStoredCommits("codex-session-a")).toEqual([
      expect.objectContaining({
        lineNumber: 6,
        commandToolCallId: "codex-exec-6",
        commitMessage: "Codex persistence",
        commitSha: null,
      }),
    ]);
    expect(mod.listStoredErrors("codex-session-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "exec_command", message: "Command failed (exit 1): npm test" }),
        expect.objectContaining({ toolName: null, message: "Rate limit recovered" }),
      ]),
    );

    await mod.syncSessionsToStorage(adapter);
    expect(parseCalls.count).toBe(1);
    metadata = JSON.parse(mod.listStoredSessions("codex")[0].metadataJson ?? "{}");
    expect(metadata.codexRuntime).toEqual(expect.objectContaining({
      lastEventType: "shutdown",
      lastEventAt: "2026-04-17T14:00:10.000Z",
    }));
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-codex-storage-"));
  tempRoots.push(root);
  return root;
}

async function loadModules(root: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "codex-persistence-test";
  vi.resetModules();

  const db = await import("./db.js");
  const repositories = await import("./repositories.js");
  const sync = await import("./sync.js");
  const evidence = await import("./evidence.js");

  storageClosers.push(() => {
    try {
      db.closeStorage();
    } catch {
      // Cleanup only.
    }
  });

  return {
    closeStorage: db.closeStorage,
    initStorage: db.initStorage,
    listIngestionCheckpoints: repositories.listIngestionCheckpoints,
    listStoredSessions: repositories.listStoredSessions,
    listTranscriptSources: repositories.listTranscriptSources,
    listStoredTurns: evidence.listStoredTurns,
    listStoredEvents: evidence.listStoredEvents,
    listStoredToolCalls: evidence.listStoredToolCalls,
    listStoredFileTouches: evidence.listStoredFileTouches,
    listStoredCommands: evidence.listStoredCommands,
    listStoredCommits: evidence.listStoredCommits,
    listStoredErrors: evidence.listStoredErrors,
    syncSessionsToStorage: sync.syncSessionsToStorage,
  };
}

function makeCodexRef(rolloutPath: string): ProviderSessionRef {
  const timestamp = new Date("2026-04-17T14:00:00.000Z");
  return toProviderSessionRef("codex", {
    id: "codex-session-a",
    path: rolloutPath,
    projectPath: "/tmp/codex-project",
    createdAt: timestamp,
    modifiedAt: timestamp,
    sizeBytes: statSync(rolloutPath).size,
  });
}

function makeCodexFixtureAdapter(
  ref: ProviderSessionRef,
  parseCalls: { count: number },
): AgentProviderAdapter {
  return {
    provider: "codex",
    async discoverSessions() {
      return [ref];
    },
    async getActiveSessions() {
      return [];
    },
    async parseSession(sessionRef) {
      parseCalls.count++;
      const parser = await import("../providers/codex/parser.js");
      const nodes = await import("../providers/codex/nodes.js");
      const events = parser.parseCodexSessionFile(sessionRef.sourcePath);
      const parsed = nodes.buildCodexParsedSession(sessionRef, events);
      return {
        parsed,
        rawEvents: events.map((event) => ({
          provider: "codex" as const,
          sessionId: sessionRef.id,
          eventType: event.type,
          line: event.line,
          timestamp: event.timestamp,
          payload: event,
        })),
        providerMetadata: parsed.codexRuntime ? { codexRuntime: parsed.codexRuntime } : {},
      };
    },
    inferSessionStatus() {
      return { status: "idle", endedAt: null, endReason: null };
    },
    resolveBusyIdle() {
      return "idle";
    },
  };
}

function createCodexRollout(root: string, sessionId: string): string {
  const rolloutDir = join(root, ".codex", "sessions", "2026", "04", "17");
  mkdirSync(rolloutDir, { recursive: true });
  const rolloutPath = join(rolloutDir, `rollout-${sessionId}.jsonl`);
  const lines = [
    codexLine("2026-04-17T14:00:00.000Z", "session_meta", {
      id: sessionId,
      cwd: "/tmp/codex-project",
      source: "codex",
      model: "gpt-5.4-codex",
    }),
    codexLine("2026-04-17T14:00:01.000Z", "event_msg", { type: "task_started" }),
    codexLine("2026-04-17T14:00:02.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "text", text: "Implement Codex persistence" }],
    }),
    codexLine("2026-04-17T14:00:03.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "I will persist Codex evidence." }],
    }),
    codexLine("2026-04-17T14:00:04.000Z", "event_msg", {
      type: "exec_command_end",
      command: ["npm", "test"],
      exit_code: 1,
      status: "error",
    }),
    codexLine("2026-04-17T14:00:05.000Z", "event_msg", {
      type: "patch_apply_end",
      files: ["src/codex.ts"],
      success: true,
    }),
    codexLine("2026-04-17T14:00:06.000Z", "event_msg", {
      type: "exec_command_end",
      command: ['git commit -m "Codex persistence"'],
      exit_code: 0,
      status: "success",
    }),
    codexLine("2026-04-17T14:00:07.000Z", "event_msg", {
      type: "error",
      message: "Rate limit recovered",
    }),
    codexLine("2026-04-17T14:00:08.000Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 42,
          output_tokens: 17,
          cached_input_tokens: 9,
        },
        model_context_window: 200000,
      },
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

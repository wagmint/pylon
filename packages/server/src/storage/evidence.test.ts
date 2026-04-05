import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface LoadedModules {
  closeStorage: () => void;
  initStorage: () => Promise<unknown>;
  syncClaudeSessionsToStorage: () => { projectCount: number; sessionCount: number };
  listStoredTurns: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredEvents: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredMessages: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredToolCalls: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredToolResults: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredFileTouches: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredCommands: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredCommits: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredApprovals: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredErrors: (sessionId?: string) => Array<Record<string, unknown>>;
  listStoredPlanItems: (sessionId?: string) => Array<Record<string, unknown>>;
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

describe("parsed evidence storage", () => {
  it("persists typed evidence rows for a Claude transcript", async () => {
    const root = createFixtureRoot();
    createEvidenceTranscript(root, "session-evidence");
    const mod = await loadModules(root);

    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    expect(mod.listStoredTurns("session-evidence")).toHaveLength(2);
    expect(mod.listStoredEvents("session-evidence")).toHaveLength(6);
    expect(mod.listStoredMessages("session-evidence")).toHaveLength(6);
    expect(mod.listStoredToolCalls("session-evidence")).toHaveLength(8);
    expect(mod.listStoredToolResults("session-evidence")).toHaveLength(6);
    expect(mod.listStoredFileTouches("session-evidence")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "read", sourceTool: "Read", filePath: "/tmp/demo/project/src/app.ts" }),
        expect.objectContaining({ action: "write", sourceTool: "Write", filePath: "/tmp/demo/project/src/new.ts" }),
        expect.objectContaining({ action: "edit", sourceTool: "Edit", filePath: "/tmp/demo/project/src/app.ts" }),
      ]),
    );
    expect(mod.listStoredCommands("session-evidence")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commandText: 'git commit -m "Add parser foundation"', isGitCommit: 1 }),
        expect.objectContaining({ commandText: "npm test", isGitCommit: 0 }),
      ]),
    );
    expect(mod.listStoredCommits("session-evidence")).toEqual([
      expect.objectContaining({ commitMessage: "Add parser foundation", commitSha: "abc1234" }),
    ]);
    expect(mod.listStoredApprovals("session-evidence")).toEqual([
      expect.objectContaining({ approvalType: "plan", status: "approved" }),
    ]);
    expect(mod.listStoredErrors("session-evidence")).toEqual([
      expect.objectContaining({ toolUseId: "t6", toolName: "Bash", message: "Error: test failed" }),
    ]);
    expect(mod.listStoredPlanItems("session-evidence")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "plan_markdown", subject: "Inspect parser" }),
        expect.objectContaining({ source: "plan_markdown", subject: "Persist events" }),
        expect.objectContaining({ source: "task_create", taskId: "7", subject: "Implement parser storage" }),
        expect.objectContaining({ source: "task_update", taskId: "7", status: "in_progress" }),
      ]),
    );
  });

  it("rewrites evidence for changed sessions without duplicating prior rows", async () => {
    const root = createFixtureRoot();
    const transcriptPath = createEvidenceTranscript(root, "session-rewrite");
    const mod = await loadModules(root);

    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();
    expect(mod.listStoredTurns("session-rewrite")).toHaveLength(2);

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-04-05T13:00:20.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Follow-up note" },
        ],
      })}\n`,
      "utf-8",
    );

    mod.syncClaudeSessionsToStorage();
    expect(mod.listStoredTurns("session-rewrite")).toHaveLength(2);
    expect(mod.listStoredEvents("session-rewrite")).toHaveLength(7);
    expect(mod.listStoredMessages("session-rewrite")).toHaveLength(7);
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-evidence-"));
  tempRoots.push(root);
  return root;
}

async function loadModules(root: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "m2-evidence-test";
  vi.resetModules();

  const db = await import("./db.js");
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
    syncClaudeSessionsToStorage: sync.syncClaudeSessionsToStorage,
    listStoredTurns: evidence.listStoredTurns,
    listStoredEvents: evidence.listStoredEvents,
    listStoredMessages: evidence.listStoredMessages,
    listStoredToolCalls: evidence.listStoredToolCalls,
    listStoredToolResults: evidence.listStoredToolResults,
    listStoredFileTouches: evidence.listStoredFileTouches,
    listStoredCommands: evidence.listStoredCommands,
    listStoredCommits: evidence.listStoredCommits,
    listStoredApprovals: evidence.listStoredApprovals,
    listStoredErrors: evidence.listStoredErrors,
    listStoredPlanItems: evidence.listStoredPlanItems,
  };
}

function createEvidenceTranscript(root: string, sessionId: string): string {
  const projectsDir = join(root, ".claude", "projects");
  const projectPath = "/tmp/demo/project";
  const encodedProjectPath = projectPath.replace(/[^a-zA-Z0-9-]/g, "-");
  const projectDir = join(projectsDir, encodedProjectPath);
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

  const lines = [
    JSON.stringify({
      timestamp: "2026-04-05T13:00:00.000Z",
      role: "user",
      content: "Build the parsed evidence layer",
      planContent: "- Inspect parser\n- Persist events",
    }),
    JSON.stringify({
      timestamp: "2026-04-05T13:00:05.000Z",
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the parser and persist typed evidence." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/demo/project/src/app.ts" } },
        { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/tmp/demo/project/src/new.ts" } },
        { type: "tool_use", id: "t3", name: "Bash", input: { command: 'git commit -m "Add parser foundation"' } },
        { type: "tool_use", id: "t4", name: "ExitPlanMode", input: { plan: "- Inspect parser\n- Persist events" } },
        { type: "tool_use", id: "t5", name: "TaskCreate", input: { subject: "Implement parser storage", description: "Store normalized evidence rows" } },
      ],
    }),
    JSON.stringify({
      timestamp: "2026-04-05T13:00:06.000Z",
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "read ok" },
        { type: "tool_result", tool_use_id: "t2", content: "write ok" },
        { type: "tool_result", tool_use_id: "t3", content: "[main abc1234] Add parser foundation" },
        { type: "tool_result", tool_use_id: "t5", content: "Task #7 created successfully" },
      ],
    }),
    JSON.stringify({
      timestamp: "2026-04-05T13:00:10.000Z",
      role: "user",
      content: "Fix the failing tests",
    }),
    JSON.stringify({
      timestamp: "2026-04-05T13:00:15.000Z",
      role: "assistant",
      content: [
        { type: "text", text: "I will run tests and patch the failure." },
        { type: "tool_use", id: "t6", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", id: "t7", name: "Edit", input: { file_path: "/tmp/demo/project/src/app.ts" } },
        { type: "tool_use", id: "t8", name: "TaskUpdate", input: { taskId: "7", status: "in_progress" } },
      ],
    }),
    JSON.stringify({
      timestamp: "2026-04-05T13:00:16.000Z",
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t6", content: "Error: test failed", is_error: true },
        { type: "tool_result", tool_use_id: "t7", content: "edit ok" },
      ],
    }),
  ];

  writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
  return transcriptPath;
}

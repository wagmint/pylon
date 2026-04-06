import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionTaskRow, TaskEvidenceRow, TaskRow } from "./tasks.js";

interface LoadedModules {
  initStorage: () => Promise<unknown>;
  closeStorage: () => void;
  syncClaudeSessionsToStorage: () => { projectCount: number; sessionCount: number };
  listStoredTasks: (projectPath?: string) => TaskRow[];
  listStoredSessionTasks: (sessionId?: string) => SessionTaskRow[];
  listStoredTaskEvidence: (taskId?: string) => TaskEvidenceRow[];
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

describe("task extraction", () => {
  it("maps explicit plan items and task_create rows into stored tasks with evidence", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-a", [
      line("2026-04-05T15:00:00.000Z", "user", "Implement task extraction", "- Add tasks table\n- Extract explicit task items"),
      JSON.stringify({
        timestamp: "2026-04-05T15:00:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "I will add the schema and extraction logic." },
          { type: "tool_use", id: "t1", name: "TaskCreate", input: { subject: "Persist task ontology", description: "Create tasks, session_tasks, and task_evidence" } },
          { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/tasks.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:00:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Task #12 created successfully" },
          { type: "tool_result", tool_use_id: "t2", content: "edit ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks.map((task) => task.title)).toEqual(
      expect.arrayContaining([
        "Add tasks table",
        "Persist task ontology",
      ]),
    );
    expect(tasks.every((task) => task.taskType === "explicit" || task.taskType === "inferred")).toBe(true);

    const sessionTasks = mod.listStoredSessionTasks("task-session-a");
    expect(sessionTasks.length).toBeGreaterThanOrEqual(2);
    expect(sessionTasks.some((row) => row.relationshipType === "primary")).toBe(true);

    const ontologyTask = tasks.find((task) => task.title === "Persist task ontology");
    expect(ontologyTask).toBeTruthy();
    expect(mod.listStoredTaskEvidence(ontologyTask!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidenceType: "task_create", sourceTable: "plan_items" }),
      ]),
    );
  });

  it("creates inferred tasks from session_state when no explicit tasks exist", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-b", [
      line("2026-04-05T15:10:00.000Z", "user", "Refactor the parser cache"),
      JSON.stringify({
        timestamp: "2026-04-05T15:10:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "I will refactor the parser cache and run tests." },
          { type: "tool_use", id: "i1", name: "Read", input: { file_path: "/tmp/demo/project/src/parser/cache.ts" } },
          { type: "tool_use", id: "i2", name: "Edit", input: { file_path: "/tmp/demo/project/src/parser/cache.ts" } },
          { type: "tool_use", id: "i3", name: "Bash", input: { command: "npm test" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:10:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "i1", content: "read ok" },
          { type: "tool_result", tool_use_id: "i2", content: "edit ok" },
          { type: "tool_result", tool_use_id: "i3", content: "tests ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskType).toBe("inferred");
    expect(tasks[0].title).toBe("Refactor the parser cache");

    const evidence = mod.listStoredTaskEvidence(tasks[0].id);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidenceType: "session_goal", sourceTable: "session_state" }),
        expect.objectContaining({ evidenceType: "file_cluster" }),
        expect.objectContaining({ evidenceType: "action_pattern", sourceTable: "commands" }),
      ]),
    );
  });

  it("uses commit messages as deterministic task signals when they are better than conversational goals", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-commit", [
      line("2026-04-05T15:11:00.000Z", "user", "hello how are you"),
      JSON.stringify({
        timestamp: "2026-04-05T15:11:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Making the change." },
          { type: "tool_use", id: "c1", name: "Edit", input: { file_path: "/tmp/demo/project/src/auth/magic-link.ts" } },
          { type: "tool_use", id: "c2", name: "Bash", input: { command: 'git commit -m "Add magic link auth flow"' } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:11:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "edit ok" },
          { type: "tool_result", tool_use_id: "c2", content: "[main abcdef1] Add magic link auth flow" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Add magic link auth flow");
    expect(mod.listStoredTaskEvidence(tasks[0].id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidenceType: "commit_message", sourceTable: "commits" }),
      ]),
    );
  });

  it("does not create bare Task N tasks from task_update events", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-update", [
      line("2026-04-05T15:12:00.000Z", "user", "Work on the parser"),
      JSON.stringify({
        timestamp: "2026-04-05T15:12:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Tracking progress." },
          { type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } },
          { type: "tool_use", id: "u2", name: "Edit", input: { file_path: "/tmp/demo/project/src/parser/cache.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:12:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "u2", content: "ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks.some((task) => /^task \d+$/i.test(task.title))).toBe(false);
  });

  it("produces stable fallback tasks from file clusters regardless of file order", async () => {
    const root = createFixtureRoot();
    // Session 1: files in one order
    createTranscript(root, "task-session-d1", [
      line("2026-04-05T15:30:00.000Z", "user", "fix it"),
      JSON.stringify({
        timestamp: "2026-04-05T15:30:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Fixing." },
          { type: "tool_use", id: "d1", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/tasks.ts" } },
          { type: "tool_use", id: "d2", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/migrations.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:30:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "d1", content: "ok" },
          { type: "tool_result", tool_use_id: "d2", content: "ok" },
        ],
      }),
    ]);
    // Session 2: same files, different order
    createTranscript(root, "task-session-d2", [
      line("2026-04-05T15:31:00.000Z", "user", "fix it"),
      JSON.stringify({
        timestamp: "2026-04-05T15:31:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Fixing." },
          { type: "tool_use", id: "d3", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/migrations.ts" } },
          { type: "tool_use", id: "d4", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/tasks.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:31:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "d3", content: "ok" },
          { type: "tool_result", tool_use_id: "d4", content: "ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain("src/storage");
    const sessionTasks = mod.listStoredSessionTasks();
    expect(sessionTasks.filter((row) => row.taskId === tasks[0].id)).toHaveLength(2);
  });

  it("filters expanded low-info goal patterns into fallback tasks", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-e", [
      line("2026-04-05T15:40:00.000Z", "user", "continue with the task"),
      JSON.stringify({
        timestamp: "2026-04-05T15:40:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Continuing." },
          { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/tmp/demo/project/src/parser/cache.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:40:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "e1", content: "ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(1);
    // Should fall through to file cluster, not use "continue with the task" as title
    expect(tasks[0].taskType).toBe("inferred");
    expect(tasks[0].title).not.toContain("continue");
    expect(tasks[0].confidence).toBeLessThan(0.7);
  });

  it("does not create inferred tasks from question-shaped goals without explicit tasks", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-question", [
      line("2026-04-05T15:41:00.000Z", "user", "if someone were running claude on conductor.build would hexdeck be able to pick it up?"),
      JSON.stringify({
        timestamp: "2026-04-05T15:41:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Investigating." },
          { type: "tool_use", id: "q1", name: "Read", input: { file_path: "/tmp/demo/project/src/parser/cache.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:41:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "q1", content: "ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(0);
  });

  it("filters conversational prefix goals even when there is execution evidence", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-prefix", [
      line("2026-04-05T15:42:00.000Z", "user", "okay now can you plan for milestone 1"),
      JSON.stringify({
        timestamp: "2026-04-05T15:42:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Planning and editing." },
          { type: "tool_use", id: "p1", name: "Edit", input: { file_path: "/tmp/demo/project/src/parser/cache.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:42:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "p1", content: "ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(0);
  });

  it("filters bracketed system text and pasted content from inferred tasks", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-system", [
      line("2026-04-05T15:43:00.000Z", "user", "[Interrupted by user]"),
      JSON.stringify({
        timestamp: "2026-04-05T15:43:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Continuing." },
          { type: "tool_use", id: "s1", name: "Edit", input: { file_path: "/tmp/demo/project/src/parser/cache.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:43:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "s1", content: "ok" },
        ],
      }),
    ]);
    createTranscript(root, "task-session-paste", [
      line("2026-04-05T15:44:00.000Z", "user", "Meeting Title: Storage Review\nDate: 2026-04-05"),
      JSON.stringify({
        timestamp: "2026-04-05T15:44:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Editing." },
          { type: "tool_use", id: "s2", name: "Edit", input: { file_path: "/tmp/demo/project/src/parser/cache.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:44:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "s2", content: "ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(0);
  });

  it("suppresses low-depth file cluster fallback tasks", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-shallow", [
      line("2026-04-05T15:45:00.000Z", "user", "check again"),
      JSON.stringify({
        timestamp: "2026-04-05T15:45:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "sh1", name: "Edit", input: { file_path: "/Users/jakejin/Documents/test.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:45:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "sh1", content: "ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(0);
  });

  it("reuses tasks across sessions when the canonical task meaning matches", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-c1", [
      line("2026-04-05T15:20:00.000Z", "user", "Add auth middleware", "- Add auth middleware"),
    ]);
    createTranscript(root, "task-session-c2", [
      line("2026-04-05T15:21:00.000Z", "user", "Add auth middleware", "- Add auth middleware"),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(1);
    const sessionTasks = mod.listStoredSessionTasks();
    expect(sessionTasks.filter((row) => row.taskId === tasks[0].id)).toHaveLength(2);
  });

  it("attaches orphan sessions to existing tasks through exact file overlap", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "task-session-existing-a", [
      line("2026-04-05T15:22:00.000Z", "user", "Add auth middleware", "- Add auth middleware"),
      JSON.stringify({
        timestamp: "2026-04-05T15:22:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Implementing auth middleware." },
          { type: "tool_use", id: "xa1", name: "Edit", input: { file_path: "/tmp/demo/project/src/auth/middleware.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:22:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "xa1", content: "ok" },
        ],
      }),
    ]);
    createTranscript(root, "task-session-existing-b", [
      line("2026-04-05T15:23:00.000Z", "user", "hello how are you"),
      JSON.stringify({
        timestamp: "2026-04-05T15:23:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Continuing the work." },
          { type: "tool_use", id: "xb1", name: "Edit", input: { file_path: "/tmp/demo/project/src/auth/middleware.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T15:23:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "xb1", content: "ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const tasks = mod.listStoredTasks("/tmp/demo/project");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Add auth middleware");

    const sessionTasks = mod.listStoredSessionTasks();
    expect(sessionTasks.filter((row) => row.taskId === tasks[0].id)).toHaveLength(2);
    expect(mod.listStoredTaskEvidence(tasks[0].id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidenceType: "existing_task_match", sourceTable: "tasks" }),
        expect.objectContaining({ evidenceType: "file_overlap", sourceTable: "file_touches" }),
      ]),
    );
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-tasks-"));
  tempRoots.push(root);
  return root;
}

async function loadModules(root: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "m4-task-test";
  vi.resetModules();

  const db = await import("./db.js");
  const sync = await import("./sync.js");
  const tasks = await import("./tasks.js");

  storageClosers.push(() => {
    try {
      db.closeStorage();
    } catch {}
  });

  return {
    initStorage: db.initStorage,
    closeStorage: db.closeStorage,
    syncClaudeSessionsToStorage: sync.syncClaudeSessionsToStorage,
    listStoredTasks: tasks.listStoredTasks,
    listStoredSessionTasks: tasks.listStoredSessionTasks,
    listStoredTaskEvidence: tasks.listStoredTaskEvidence,
  };
}

function createTranscript(root: string, sessionId: string, lines: string[]): void {
  const projectPath = "/tmp/demo/project";
  const projectsDir = join(root, ".claude", "projects");
  const projectDir = join(projectsDir, projectPath.replace(/[^a-zA-Z0-9-]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
}

function line(timestamp: string, role: "user" | "assistant", content: string, planContent?: string): string {
  return JSON.stringify({
    timestamp,
    role,
    content,
    ...(planContent ? { planContent } : {}),
  });
}

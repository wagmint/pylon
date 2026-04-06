import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  WorkstreamEvidenceRow,
  WorkstreamRow,
  WorkstreamSessionRow,
  WorkstreamStateRow,
  WorkstreamTaskRow,
} from "./workstreams.js";

interface LoadedModules {
  initStorage: () => Promise<unknown>;
  closeStorage: () => void;
  syncClaudeSessionsToStorage: () => { projectCount: number; sessionCount: number };
  listStoredWorkstreams: (projectPath?: string) => WorkstreamRow[];
  listStoredWorkstreamTasks: (workstreamId?: string) => WorkstreamTaskRow[];
  listStoredWorkstreamSessions: (workstreamId?: string) => WorkstreamSessionRow[];
  listStoredWorkstreamEvidence: (workstreamId?: string) => WorkstreamEvidenceRow[];
  listStoredWorkstreamState: (workstreamId?: string) => WorkstreamStateRow[];
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

describe("workstream model", () => {
  it("groups project tasks and sessions into one durable workstream", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "/tmp/demo/project/a", "ws-a1", [
      line("2026-04-05T16:00:00.000Z", "user", "Implement workstream model", "- Add workstreams\n- Group tasks"),
      line("2026-04-05T16:00:01.000Z", "assistant", "Working on it."),
    ]);
    createTranscript(root, "/tmp/demo/project/a", "ws-a2", [
      line("2026-04-05T16:01:00.000Z", "user", "Refine workstream summaries", "- Improve summaries"),
      line("2026-04-05T16:01:01.000Z", "assistant", "Working on it."),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const workstreams = mod.listStoredWorkstreams("/tmp/demo/project/a");
    expect(workstreams).toHaveLength(1);
    expect(workstreams[0].title.length).toBeGreaterThan(0);
    expect(workstreams[0].summary).toContain("Tasks:");
    expect(workstreams[0].summary).toContain("Add workstreams");

    const links = mod.listStoredWorkstreamTasks(workstreams[0].id);
    expect(links.length).toBeGreaterThanOrEqual(2);

    const sessions = mod.listStoredWorkstreamSessions(workstreams[0].id);
    expect(sessions).toHaveLength(2);

    const state = mod.listStoredWorkstreamState(workstreams[0].id)[0];
    expect(state.sessionCount).toBe(2);
    expect(state.activeTaskCount).toBeGreaterThanOrEqual(2);

    const evidence = mod.listStoredWorkstreamEvidence(workstreams[0].id);
    expect(evidence.some((row) => row.evidenceType === "session_goal")).toBe(true);
  });

  it("creates separate workstreams for separate projects", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "/tmp/demo/project/b", "ws-b1", [
      line("2026-04-05T16:10:00.000Z", "user", "Add auth middleware", "- Add auth middleware"),
    ]);
    createTranscript(root, "/tmp/demo/project/c", "ws-c1", [
      line("2026-04-05T16:11:00.000Z", "user", "Build storage dashboard", "- Build storage dashboard"),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const all = mod.listStoredWorkstreams();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((row) => row.projectPath))).toEqual(new Set([
      "/tmp/demo/project/b",
      "/tmp/demo/project/c",
    ]));
  });

  it("derives completed workstream state when all tasks are completed", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "/tmp/demo/project/d", "ws-d1", [
      line("2026-04-05T16:20:00.000Z", "user", "Ship final work", "- Ship final work"),
      JSON.stringify({
        timestamp: "2026-04-05T16:20:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Committing the final change." },
          { type: "tool_use", id: "c1", name: "Bash", input: { command: 'git commit -m "Ship final work"' } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T16:20:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "[main abcdef1] Ship final work" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const workstream = mod.listStoredWorkstreams("/tmp/demo/project/d")[0];
    const state = mod.listStoredWorkstreamState(workstream.id)[0];
    expect(workstream.status).toBe("completed");
    expect(state.status).toBe("completed");
    expect(state.completedTaskCount).toBeGreaterThanOrEqual(1);
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-workstreams-"));
  tempRoots.push(root);
  return root;
}

async function loadModules(root: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "m5-workstream-test";
  vi.resetModules();

  const db = await import("./db.js");
  const sync = await import("./sync.js");
  const workstreams = await import("./workstreams.js");

  storageClosers.push(() => {
    try {
      db.closeStorage();
    } catch {}
  });

  return {
    initStorage: db.initStorage,
    closeStorage: db.closeStorage,
    syncClaudeSessionsToStorage: sync.syncClaudeSessionsToStorage,
    listStoredWorkstreams: workstreams.listStoredWorkstreams,
    listStoredWorkstreamTasks: workstreams.listStoredWorkstreamTasks,
    listStoredWorkstreamSessions: workstreams.listStoredWorkstreamSessions,
    listStoredWorkstreamEvidence: workstreams.listStoredWorkstreamEvidence,
    listStoredWorkstreamState: workstreams.listStoredWorkstreamState,
  };
}

function createTranscript(root: string, projectPath: string, sessionId: string, lines: string[]): void {
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

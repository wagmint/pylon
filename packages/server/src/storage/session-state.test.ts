import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface LoadedModules {
  initStorage: () => Promise<unknown>;
  closeStorage: () => void;
  syncClaudeSessionsToStorage: () => { projectCount: number; sessionCount: number };
  listStoredSessionState: (sessionId?: string) => Array<{
    status: string;
    currentGoal: string;
    lastMeaningfulAction: string;
    resumeSummary: string;
    blockedReason: string | null;
    pendingApprovalCount: number;
    filesInPlayJson: string;
    lastTurnIndex: number | null;
  }>;
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

describe("session state model", () => {
  it("derives in-progress session state from plan, actions, and files in play", async () => {
    const root = createFixtureRoot();
    createSessionTranscript(root, "session-state-a", [
      line("2026-04-05T14:00:00.000Z", "user", "Implement session state model", "- Add session_state table\n- Derive current goal"),
      JSON.stringify({
        timestamp: "2026-04-05T14:00:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "I will derive session state and persist it." },
          { type: "tool_use", id: "c1", name: "Read", input: { file_path: "/tmp/demo/project/src/storage/evidence.ts" } },
          { type: "tool_use", id: "c2", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/session-state.ts" } },
          { type: "tool_use", id: "c3", name: "TaskCreate", input: { subject: "Derive session state", description: "Compute status, goal, and resume summary" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T14:00:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "read ok" },
          { type: "tool_result", tool_use_id: "c2", content: "edit ok" },
          { type: "tool_result", tool_use_id: "c3", content: "Task #9 created successfully" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const state = mod.listStoredSessionState("session-state-a")[0];
    expect(state.status).toBe("in_progress");
    expect(state.currentGoal).toBe("Derive session state");
    expect(state.lastMeaningfulAction).toBe("Touched 2 files");
    expect(state.blockedReason).toBeNull();
    expect(state.pendingApprovalCount).toBe(0);
    expect(JSON.parse(state.filesInPlayJson)).toEqual([
      "/tmp/demo/project/src/storage/session-state.ts",
      "/tmp/demo/project/src/storage/evidence.ts",
    ]);
    expect(state.resumeSummary).toContain("Goal: Derive session state");
    expect(state.resumeSummary).toContain("Files in play:");
  });

  it("marks sessions blocked on rejected approvals", async () => {
    const root = createFixtureRoot();
    createSessionTranscript(root, "session-state-b", [
      line("2026-04-05T14:10:00.000Z", "user", "Propose a plan"),
      JSON.stringify({
        timestamp: "2026-04-05T14:10:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Here is the plan." },
          { type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "- Step one\n- Step two" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T14:10:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "p1", content: "tool use was rejected" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const state = mod.listStoredSessionState("session-state-b")[0];
    expect(state.status).toBe("blocked");
    expect(state.blockedReason).toContain("approval rejected");
    expect(state.resumeSummary).toContain("Blocked on:");
  });

  it("marks sessions stalled on unresolved errors", async () => {
    const root = createFixtureRoot();
    createSessionTranscript(root, "session-state-c", [
      line("2026-04-05T14:20:00.000Z", "user", "Run the tests"),
      JSON.stringify({
        timestamp: "2026-04-05T14:20:03.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Running test suite." },
          { type: "tool_use", id: "e1", name: "Bash", input: { command: "npm test" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-05T14:20:04.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "e1", content: "Error: test failed", is_error: true },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const state = mod.listStoredSessionState("session-state-c")[0];
    expect(state.status).toBe("stalled");
    expect(state.blockedReason).toBe("Error: test failed");
    expect(state.lastMeaningfulAction).toBe("Ran command: npm test");
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-session-state-"));
  tempRoots.push(root);
  return root;
}

async function loadModules(root: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "m3-session-state-test";
  vi.resetModules();

  const db = await import("./db.js");
  const sync = await import("./sync.js");
  const sessionState = await import("./session-state.js");

  storageClosers.push(() => {
    try {
      db.closeStorage();
    } catch {}
  });

  return {
    initStorage: db.initStorage,
    closeStorage: db.closeStorage,
    syncClaudeSessionsToStorage: sync.syncClaudeSessionsToStorage,
    listStoredSessionState: sessionState.listStoredSessionState,
  };
}

function createSessionTranscript(root: string, sessionId: string, lines: string[]): string {
  const projectPath = "/tmp/demo/project";
  const projectsDir = join(root, ".claude", "projects");
  const projectDir = join(projectsDir, projectPath.replace(/[^a-zA-Z0-9-]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
  return transcriptPath;
}

function line(timestamp: string, role: "user" | "assistant", content: string, planContent?: string): string {
  return JSON.stringify({
    timestamp,
    role,
    content,
    ...(planContent ? { planContent } : {}),
  });
}

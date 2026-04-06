import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HandoffAttachmentRow, HandoffRow } from "./handoffs.js";
import type { ArtifactRow } from "./m6.js";
import type { TaskRow } from "./tasks.js";
import type { WorkstreamRow } from "./workstreams.js";

interface LoadedModules {
  initStorage: () => Promise<unknown>;
  closeStorage: () => void;
  syncClaudeSessionsToStorage: () => { projectCount: number; sessionCount: number };
  listStoredHandoffs: (projectPath?: string) => HandoffRow[];
  listStoredHandoffTasks: (handoffId?: string) => HandoffAttachmentRow[];
  listStoredHandoffWorkstreams: (handoffId?: string) => HandoffAttachmentRow[];
  listStoredHandoffArtifacts: (handoffId?: string) => HandoffAttachmentRow[];
  listStoredTasks: (projectPath?: string) => TaskRow[];
  listStoredWorkstreams: (projectPath?: string) => WorkstreamRow[];
  listStoredArtifacts: (projectPath?: string) => ArtifactRow[];
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

describe("handoffs and cross-session memory", () => {
  it("creates blocked-session handoffs with resume package and graph attachments", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "handoff-blocked", [
      line("2026-04-06T12:00:00.000Z", "user", "Plan the blocker handling", "- Add blocker handoffs"),
      JSON.stringify({
        timestamp: "2026-04-06T12:00:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Preparing the blocked-session handoff." },
          { type: "tool_use", id: "hb-task", name: "TaskCreate", input: { subject: "Add blocker handoffs", description: "Generate resume packages for blocked sessions" } },
          { type: "tool_use", id: "hb-file", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/handoffs.ts" } },
          { type: "tool_use", id: "hb-plan", name: "ExitPlanMode", input: { plan: "- Add blocker handoffs\n- Wire resume package" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-06T12:00:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "hb-file", content: "edit ok" },
          { type: "tool_result", tool_use_id: "hb-plan", content: "tool use was rejected" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const handoffs = mod.listStoredHandoffs("/tmp/demo/project");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].handoffType).toBe("blocked");
    expect(handoffs[0].summary).toContain("Blocked on:");
    expect(JSON.parse(handoffs[0].openQuestionsJson)[0]).toContain("approval rejected");

    const resumePackage = JSON.parse(handoffs[0].resumePackageJson);
    expect(resumePackage.goal).toBe("Add blocker handoffs");
    expect(resumePackage.blockedReason).toContain("approval rejected");
    expect(resumePackage.filesInPlay).toContain("/tmp/demo/project/src/storage/handoffs.ts");

    const task = mod.listStoredTasks("/tmp/demo/project").find((row) => row.title === "Add blocker handoffs");
    const workstream = mod.listStoredWorkstreams("/tmp/demo/project")[0];
    const artifact = mod.listStoredArtifacts("/tmp/demo/project").find((row) => row.filePath === "/tmp/demo/project/src/storage/handoffs.ts");
    expect(task).toBeTruthy();
    expect(workstream).toBeTruthy();
    expect(artifact).toBeTruthy();
    expect(mod.listStoredHandoffTasks(handoffs[0].id).some((row) => row.ownerId === task!.id)).toBe(true);
    expect(mod.listStoredHandoffWorkstreams(handoffs[0].id).some((row) => row.ownerId === workstream.id)).toBe(true);
    expect(mod.listStoredHandoffArtifacts(handoffs[0].id).some((row) => row.ownerId === artifact!.id)).toBe(true);
  });

  it("creates compacted-session handoffs with compaction context and next steps", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "handoff-compacted", [
      line("2026-04-06T12:10:00.000Z", "user", "Refine the resume package"),
      JSON.stringify({
        timestamp: "2026-04-06T12:10:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Refining handoff context." },
          { type: "tool_use", id: "hc-file", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/resume.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-06T12:10:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "hc-file", content: "edit ok" },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-06T12:10:07.000Z",
        role: "assistant",
        content: [
          { type: "compaction", content: "Condensed prior context around resume package derivation" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const handoffs = mod.listStoredHandoffs("/tmp/demo/project");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].handoffType).toBe("compacted");
    expect(handoffs[0].summary).toContain("Compaction:");
    expect(JSON.parse(handoffs[0].openQuestionsJson)[0]).toContain("Restore context after compaction");

    const nextSteps = JSON.parse(handoffs[0].nextStepsJson);
    expect(nextSteps[0]).toContain("Rehydrate context and continue");
    expect(nextSteps.some((step: string) => step.includes("Reopen files:"))).toBe(true);
  });

  it("does not create handoffs for active in-progress sessions", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "handoff-active", [
      line("2026-04-06T12:20:00.000Z", "user", "Keep implementing handoffs", "- Keep implementing handoffs"),
      JSON.stringify({
        timestamp: "2026-04-06T12:20:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Continuing active work." },
          { type: "tool_use", id: "ha-file", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/handoffs.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-06T12:20:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "ha-file", content: "edit ok" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    expect(mod.listStoredHandoffs("/tmp/demo/project")).toHaveLength(0);
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-handoffs-"));
  tempRoots.push(root);
  return root;
}

async function loadModules(root: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "m7-handoff-test";
  vi.resetModules();

  const db = await import("./db.js");
  const sync = await import("./sync.js");
  const handoffs = await import("./handoffs.js");
  const tasks = await import("./tasks.js");
  const workstreams = await import("./workstreams.js");
  const m6 = await import("./m6.js");

  storageClosers.push(() => {
    try {
      db.closeStorage();
    } catch {}
  });

  return {
    initStorage: db.initStorage,
    closeStorage: db.closeStorage,
    syncClaudeSessionsToStorage: sync.syncClaudeSessionsToStorage,
    listStoredHandoffs: handoffs.listStoredHandoffs,
    listStoredHandoffTasks: handoffs.listStoredHandoffTasks,
    listStoredHandoffWorkstreams: handoffs.listStoredHandoffWorkstreams,
    listStoredHandoffArtifacts: handoffs.listStoredHandoffArtifacts,
    listStoredTasks: tasks.listStoredTasks,
    listStoredWorkstreams: workstreams.listStoredWorkstreams,
    listStoredArtifacts: m6.listStoredArtifacts,
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

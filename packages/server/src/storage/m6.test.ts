import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ArtifactAttachmentRow,
  ArtifactRow,
  BlockerAttachmentRow,
  BlockerEvidenceRow,
  BlockerRow,
  DecisionAttachmentRow,
  DecisionEvidenceRow,
  DecisionRow,
} from "./m6.js";
import type { TaskRow } from "./tasks.js";
import type { WorkstreamRow } from "./workstreams.js";

interface LoadedModules {
  initStorage: () => Promise<unknown>;
  closeStorage: () => void;
  syncClaudeSessionsToStorage: () => { projectCount: number; sessionCount: number };
  listStoredArtifacts: (projectPath?: string) => ArtifactRow[];
  listStoredTaskArtifacts: (taskId?: string) => ArtifactAttachmentRow[];
  listStoredSessionArtifacts: (sessionId?: string) => ArtifactAttachmentRow[];
  listStoredWorkstreamArtifacts: (workstreamId?: string) => ArtifactAttachmentRow[];
  listStoredDecisions: (projectPath?: string) => DecisionRow[];
  listStoredDecisionEvidence: (decisionId?: string) => DecisionEvidenceRow[];
  listStoredTaskDecisions: (taskId?: string) => DecisionAttachmentRow[];
  listStoredSessionDecisions: (sessionId?: string) => DecisionAttachmentRow[];
  listStoredWorkstreamDecisions: (workstreamId?: string) => DecisionAttachmentRow[];
  listStoredBlockers: (projectPath?: string) => BlockerRow[];
  listStoredBlockerEvidence: (blockerId?: string) => BlockerEvidenceRow[];
  listStoredTaskBlockers: (taskId?: string) => BlockerAttachmentRow[];
  listStoredSessionBlockers: (sessionId?: string) => BlockerAttachmentRow[];
  listStoredWorkstreamBlockers: (workstreamId?: string) => BlockerAttachmentRow[];
  listStoredTasks: (projectPath?: string) => TaskRow[];
  listStoredWorkstreams: (projectPath?: string) => WorkstreamRow[];
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

describe("m6 artifacts, decisions, and blockers", () => {
  it("stores file and commit artifacts with task and workstream attachments", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "m6-artifacts", [
      line("2026-04-06T09:00:00.000Z", "user", "Implement storage artifact model", "- Add artifact ontology"),
      JSON.stringify({
        timestamp: "2026-04-06T09:00:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Implementing artifacts." },
          { type: "tool_use", id: "a1", name: "Edit", input: { file_path: "/tmp/demo/project/src/storage/m6.ts" } },
          { type: "tool_use", id: "a2", name: "Bash", input: { command: 'git commit -m "Add artifact ontology"' } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-06T09:00:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a1", content: "edit ok" },
          { type: "tool_result", tool_use_id: "a2", content: "[main abc1234] Add artifact ontology" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const artifacts = mod.listStoredArtifacts("/tmp/demo/project");
    expect(artifacts.map((row) => row.artifactType)).toEqual(expect.arrayContaining(["file_change", "commit"]));

    const task = mod.listStoredTasks("/tmp/demo/project")[0];
    const workstream = mod.listStoredWorkstreams("/tmp/demo/project")[0];
    expect(mod.listStoredSessionArtifacts("m6-artifacts").length).toBeGreaterThanOrEqual(2);
    expect(mod.listStoredTaskArtifacts(task.id).length).toBeGreaterThanOrEqual(2);
    expect(mod.listStoredWorkstreamArtifacts(workstream.id).length).toBeGreaterThanOrEqual(2);
  });

  it("stores one file artifact per file and attaches all contributing sessions", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "m6-file-a", [
      line("2026-04-06T09:05:00.000Z", "user", "Edit shared file", "- Edit shared file"),
      JSON.stringify({
        timestamp: "2026-04-06T09:05:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Editing shared file." },
          { type: "tool_use", id: "f1", name: "Edit", input: { file_path: "/tmp/demo/project/src/shared.ts" } },
        ],
      }),
    ]);
    createTranscript(root, "m6-file-b", [
      line("2026-04-06T09:06:00.000Z", "user", "Edit shared file again", "- Edit shared file again"),
      JSON.stringify({
        timestamp: "2026-04-06T09:06:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Editing shared file again." },
          { type: "tool_use", id: "f2", name: "Edit", input: { file_path: "/tmp/demo/project/src/shared.ts" } },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const artifacts = mod.listStoredArtifacts("/tmp/demo/project");
    const sharedArtifacts = artifacts.filter((row) => row.filePath === "/tmp/demo/project/src/shared.ts");
    expect(sharedArtifacts).toHaveLength(1);

    const artifactId = sharedArtifacts[0].id;
    expect(mod.listStoredSessionArtifacts("m6-file-a").some((row) => row.artifactId === artifactId)).toBe(true);
    expect(mod.listStoredSessionArtifacts("m6-file-b").some((row) => row.artifactId === artifactId)).toBe(true);
  });

  it("stores approval decisions and blocker explanations with evidence and attachments", async () => {
    const root = createFixtureRoot();
    createTranscript(root, "m6-approved", [
      line("2026-04-06T09:10:00.000Z", "user", "Propose the rollout plan"),
      JSON.stringify({
        timestamp: "2026-04-06T09:10:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Here is the plan." },
          { type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "- Add decisions table\n- Wire evidence links" } },
        ],
      }),
    ]);
    createTranscript(root, "m6-blocked", [
      line("2026-04-06T09:20:00.000Z", "user", "Propose a blocker plan"),
      JSON.stringify({
        timestamp: "2026-04-06T09:20:05.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "Need approval to continue." },
          { type: "tool_use", id: "p2-task", name: "TaskCreate", input: { subject: "Add blockers table", description: "Add blockers table and explain blocked state" } },
          { type: "tool_use", id: "p2", name: "ExitPlanMode", input: { plan: "- Add blockers table\n- Explain blocked state" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-04-06T09:20:06.000Z",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "p2", content: "tool use was rejected" },
        ],
      }),
    ]);

    const mod = await loadModules(root);
    await mod.initStorage();
    mod.syncClaudeSessionsToStorage();

    const decisions = mod.listStoredDecisions("/tmp/demo/project");
    expect(decisions.some((row) => row.status === "approved")).toBe(true);
    expect(decisions.some((row) => row.status === "rejected")).toBe(true);
    expect(decisions.find((row) => row.status === "approved")?.confidence).toBe(0.7);

    const rejectedDecision = decisions.find((row) => row.status === "rejected");
    expect(rejectedDecision).toBeTruthy();
    expect(mod.listStoredDecisionEvidence(rejectedDecision!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceTable: "approvals" }),
      ]),
    );

    const allTasks = mod.listStoredTasks("/tmp/demo/project");
    const blockedTask = allTasks.find((task) => task.title === "Add blockers table");
    const workstream = mod.listStoredWorkstreams("/tmp/demo/project")[0];
    expect(blockedTask).toBeTruthy();
    expect(mod.listStoredSessionDecisions("m6-blocked").length).toBeGreaterThanOrEqual(1);
    expect(mod.listStoredTaskDecisions(blockedTask!.id).length).toBeGreaterThanOrEqual(1);
    expect(mod.listStoredWorkstreamDecisions(workstream.id).length).toBeGreaterThanOrEqual(1);

    const blockers = mod.listStoredBlockers("/tmp/demo/project");
    expect(blockers).toHaveLength(1);
    expect(blockers[0].blockerType).toBe("approval_rejected");
    expect(blockers[0].summary).toContain("approval rejected");
    expect(mod.listStoredBlockerEvidence(blockers[0].id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceTable: "session_state" }),
        expect.objectContaining({ sourceTable: "approvals" }),
      ]),
    );
    expect(mod.listStoredSessionBlockers("m6-blocked")).toHaveLength(1);
    expect(mod.listStoredTaskBlockers(blockedTask!.id)).toHaveLength(1);
    expect(mod.listStoredWorkstreamBlockers(workstream.id).length).toBeGreaterThanOrEqual(1);
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hexdeck-m6-"));
  tempRoots.push(root);
  return root;
}

async function loadModules(root: string): Promise<LoadedModules> {
  process.env.HEXDECK_HOME_DIR = root;
  process.env.HEXDECK_CLAUDE_DIR = join(root, ".claude");
  process.env.HEXDECK_STORAGE_PARSER_VERSION = "m6-test";
  vi.resetModules();

  const db = await import("./db.js");
  const sync = await import("./sync.js");
  const m6 = await import("./m6.js");
  const tasks = await import("./tasks.js");
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
    listStoredArtifacts: m6.listStoredArtifacts,
    listStoredTaskArtifacts: m6.listStoredTaskArtifacts,
    listStoredSessionArtifacts: m6.listStoredSessionArtifacts,
    listStoredWorkstreamArtifacts: m6.listStoredWorkstreamArtifacts,
    listStoredDecisions: m6.listStoredDecisions,
    listStoredDecisionEvidence: m6.listStoredDecisionEvidence,
    listStoredTaskDecisions: m6.listStoredTaskDecisions,
    listStoredSessionDecisions: m6.listStoredSessionDecisions,
    listStoredWorkstreamDecisions: m6.listStoredWorkstreamDecisions,
    listStoredBlockers: m6.listStoredBlockers,
    listStoredBlockerEvidence: m6.listStoredBlockerEvidence,
    listStoredTaskBlockers: m6.listStoredTaskBlockers,
    listStoredSessionBlockers: m6.listStoredSessionBlockers,
    listStoredWorkstreamBlockers: m6.listStoredWorkstreamBlockers,
    listStoredTasks: tasks.listStoredTasks,
    listStoredWorkstreams: workstreams.listStoredWorkstreams,
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

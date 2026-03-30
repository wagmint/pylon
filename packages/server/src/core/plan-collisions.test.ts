import { describe, it, expect } from "vitest";
import { detectLocalPlanCollisions } from "./plan-collisions.js";
import type { Agent, AgentRisk, SessionPlan, PlanTask } from "../types/index.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const NOW = new Date("2026-03-29T12:00:00.000Z");

const DEFAULT_RISK: AgentRisk = {
  errorRate: 0,
  correctionRatio: 1,
  totalTokens: 0,
  compactions: 0,
  compactionProximity: "nominal",
  fileHotspots: [],
  spinningSignals: [],
  overallRisk: "nominal",
  errorTrend: [],
  modelBreakdown: [],
  sourceBreakdown: [],
  contextUsagePct: 0,
  contextTokens: 0,
  avgTurnTimeMs: null,
  sessionDurationMs: 0,
  costEstimate: 0,
};

function makePlan(overrides?: Partial<SessionPlan>): SessionPlan {
  return {
    status: "implementing",
    markdown: "# Default plan\nSome plan content",
    tasks: [],
    agentLabel: "agent-1",
    timestamp: NOW,
    planDurationMs: null,
    draftingActivity: null,
    isFromActiveSession: true,
    ...overrides,
  };
}

function makeTask(subject: string, overrides?: Partial<PlanTask>): PlanTask {
  return {
    id: `task-${subject.replace(/\s/g, "-")}`,
    subject,
    description: "",
    status: "pending",
    ...overrides,
  };
}

function makeAgent(overrides?: Partial<Agent>): Agent {
  return {
    sessionId: "session-1",
    label: "agent-1",
    agentType: "claude",
    status: "busy",
    currentTask: "",
    filesChanged: [],
    uncommittedFiles: [],
    projectPath: "/project",
    isActive: true,
    plans: [makePlan()],
    risk: DEFAULT_RISK,
    operatorId: "op-self",
    recentTurns: [],
    skippedTurnCount: 0,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("detectLocalPlanCollisions", () => {
  describe("returns empty when no collision possible", () => {
    it("returns [] for empty agents array", () => {
      expect(detectLocalPlanCollisions([])).toEqual([]);
    });

    it("returns [] for a single agent", () => {
      expect(detectLocalPlanCollisions([makeAgent()])).toEqual([]);
    });

    it("returns [] for agents with different operatorIds", () => {
      const agents = [
        makeAgent({ sessionId: "s1", operatorId: "op-alice" }),
        makeAgent({ sessionId: "s2", operatorId: "op-bob" }),
      ];
      expect(detectLocalPlanCollisions(agents)).toEqual([]);
    });

    it("returns [] for agents with different projectPaths", () => {
      const agents = [
        makeAgent({ sessionId: "s1", projectPath: "/project-a" }),
        makeAgent({ sessionId: "s2", projectPath: "/project-b" }),
      ];
      expect(detectLocalPlanCollisions(agents)).toEqual([]);
    });

    it("returns [] for agents with completely unrelated plans", () => {
      const agents = [
        makeAgent({
          sessionId: "s1",
          label: "agent-1",
          plans: [makePlan({ markdown: "# Add user login\nImplement OAuth flow" })],
        }),
        makeAgent({
          sessionId: "s2",
          label: "agent-2",
          plans: [makePlan({ markdown: "# Fix database migration\nUpdate schema for v3" })],
        }),
      ];
      expect(detectLocalPlanCollisions(agents)).toEqual([]);
    });

    it("returns [] for inactive agents", () => {
      const agents = [
        makeAgent({ sessionId: "s1", isActive: false }),
        makeAgent({ sessionId: "s2", isActive: false }),
      ];
      expect(detectLocalPlanCollisions(agents)).toEqual([]);
    });

    it("returns [] for codex agents", () => {
      const agents = [
        makeAgent({ sessionId: "s1", agentType: "codex" }),
        makeAgent({ sessionId: "s2", agentType: "codex" }),
      ];
      expect(detectLocalPlanCollisions(agents)).toEqual([]);
    });
  });

  describe("duplicate_plan detection", () => {
    it("detects duplicate when two agents have very similar plan summaries", () => {
      const agents = [
        makeAgent({
          sessionId: "s1",
          label: "agent-1",
          plans: [makePlan({
            markdown: "# Implement user authentication with OAuth\nAdd login flow with Google OAuth provider",
            tasks: [makeTask("Add OAuth login flow"), makeTask("Create user session management")],
          })],
        }),
        makeAgent({
          sessionId: "s2",
          label: "agent-2",
          plans: [makePlan({
            markdown: "# Implement user authentication with OAuth\nAdd login flow with Google OAuth provider",
            tasks: [makeTask("Add OAuth login flow"), makeTask("Create user session management")],
          })],
        }),
      ];
      const collisions = detectLocalPlanCollisions(agents);
      expect(collisions.length).toBeGreaterThanOrEqual(1);
      expect(collisions[0].type).toBe("duplicate_plan");
    });
  });

  describe("overlapping_task detection", () => {
    it("detects overlap when agents share task subjects but have different plans", () => {
      const agents = [
        makeAgent({
          sessionId: "s1",
          label: "agent-1",
          plans: [makePlan({
            markdown: "# Refactor database layer\nClean up query builders",
            tasks: [makeTask("Implement pagination component"), makeTask("Add search bar")],
          })],
        }),
        makeAgent({
          sessionId: "s2",
          label: "agent-2",
          plans: [makePlan({
            markdown: "# Build user interface\nCreate frontend components",
            tasks: [makeTask("Implement pagination component"), makeTask("Add sidebar nav")],
          })],
        }),
      ];
      const collisions = detectLocalPlanCollisions(agents);
      expect(collisions.length).toBeGreaterThanOrEqual(1);
      const types = collisions.map((c) => c.type);
      expect(types.some((t) => t === "overlapping_task" || t === "duplicate_plan")).toBe(true);
    });
  });

  describe("contradictory_plan detection", () => {
    it("detects contradiction when plans have opposing approaches", () => {
      const agents = [
        makeAgent({
          sessionId: "s1",
          label: "agent-1",
          plans: [makePlan({
            markdown: "# Centralize configuration management\nConsolidate all config into a single module",
            tasks: [makeTask("Centralize config files"), makeTask("Remove scattered config")],
          })],
        }),
        makeAgent({
          sessionId: "s2",
          label: "agent-2",
          plans: [makePlan({
            markdown: "# Inline configuration for each module\nMove config closer to usage",
            tasks: [makeTask("Inline config into each module"), makeTask("Add local config files")],
          })],
        }),
      ];
      const collisions = detectLocalPlanCollisions(agents);
      expect(collisions.length).toBeGreaterThanOrEqual(1);
      expect(collisions[0].type).toBe("contradictory_plan");
      expect(collisions[0].severity).toBe("critical");
    });

    it("detects remove vs add contradiction", () => {
      const agents = [
        makeAgent({
          sessionId: "s1",
          label: "agent-1",
          plans: [makePlan({
            markdown: "# Remove legacy authentication\nDelete old auth middleware and clean up",
            tasks: [makeTask("Remove old auth middleware"), makeTask("Delete legacy auth routes")],
          })],
        }),
        makeAgent({
          sessionId: "s2",
          label: "agent-2",
          plans: [makePlan({
            markdown: "# Add authentication features\nIntroduce new auth middleware with OAuth",
            tasks: [makeTask("Add new auth middleware"), makeTask("Introduce OAuth provider")],
          })],
        }),
      ];
      const collisions = detectLocalPlanCollisions(agents);
      expect(collisions.length).toBeGreaterThanOrEqual(1);
      expect(collisions[0].type).toBe("contradictory_plan");
    });
  });

  describe("sorting", () => {
    it("sorts critical before warning", () => {
      const agents = [
        // This pair: overlapping (warning)
        makeAgent({
          sessionId: "s1",
          label: "agent-1",
          plans: [makePlan({
            markdown: "# Work on widget system\nBuild reusable widgets",
            tasks: [makeTask("Create widget framework"), makeTask("Build reusable components")],
          })],
        }),
        makeAgent({
          sessionId: "s2",
          label: "agent-2",
          plans: [makePlan({
            markdown: "# Work on widget system\nBuild reusable widgets",
            tasks: [makeTask("Create widget framework"), makeTask("Build reusable components")],
          })],
        }),
        // This pair: contradictory (critical)
        makeAgent({
          sessionId: "s3",
          label: "agent-3",
          plans: [makePlan({
            markdown: "# Centralize widget config\nConsolidate all widget settings",
            tasks: [makeTask("Centralize widget settings"), makeTask("Consolidate config")],
          })],
        }),
        makeAgent({
          sessionId: "s4",
          label: "agent-4",
          plans: [makePlan({
            markdown: "# Inline widget config\nMove widget settings closer to usage",
            tasks: [makeTask("Inline widget settings"), makeTask("Split config per module")],
          })],
        }),
      ];
      const collisions = detectLocalPlanCollisions(agents);
      if (collisions.length >= 2) {
        const hasCritical = collisions.some((c) => c.severity === "critical");
        if (hasCritical) {
          expect(collisions[0].severity).toBe("critical");
        }
      }
    });
  });

  describe("edge cases", () => {
    it("skips agents with no plans", () => {
      const agents = [
        makeAgent({ sessionId: "s1", plans: [] }),
        makeAgent({ sessionId: "s2", plans: [] }),
      ];
      expect(detectLocalPlanCollisions(agents)).toEqual([]);
    });

    it("skips agents whose plans have only low-information tasks", () => {
      const agents = [
        makeAgent({
          sessionId: "s1",
          plans: [makePlan({ markdown: null, tasks: [makeTask("continue")] })],
        }),
        makeAgent({
          sessionId: "s2",
          plans: [makePlan({ markdown: null, tasks: [makeTask("try again")] })],
        }),
      ];
      expect(detectLocalPlanCollisions(agents)).toEqual([]);
    });
  });
});

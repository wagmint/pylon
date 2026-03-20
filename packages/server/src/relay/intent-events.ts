import { createHash } from "node:crypto";
import type {
  Agent,
  DashboardState,
  FeedEvent,
  ParsedSession,
  SessionPlan,
  TurnNode,
  Workstream,
} from "../types/index.js";
import { computeTurnCost } from "../core/pricing.js";

export type IntentEventSource = "claude" | "codex";
export type IntentEventType =
  | "session_updated"
  | "session_ended"
  | "user_turn"
  | "assistant_turn"
  | "reasoning_observed"
  | "plan_started"
  | "plan_updated"
  | "plan_completed"
  | "plan_rejected"
  | "task_created"
  | "task_updated"
  | "files_explored"
  | "files_changed"
  | "search_performed"
  | "command_executed"
  | "commit_created"
  | "compaction";

export interface NormalizedIntentEvent {
  eventId: string;
  schemaVersion: "v1";
  source: IntentEventSource;
  operatorId: string;
  sessionId: string;
  projectPath: string;
  occurredAt: string;
  eventType: IntentEventType;
  payload: Record<string, unknown>;
  provenance: {
    signalType: "explicit" | "inferred";
    sourceDetail: string;
  };
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function iso(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function sourceDetailForAgent(agentType: IntentEventSource, explicit = false): string {
  if (explicit) {
    return agentType === "claude" ? "claude_plan_mode" : "codex_execution_trace";
  }
  return agentType === "claude" ? "claude_turn_summary" : "codex_turn_summary";
}

function makeEventId(parts: Array<string | number | null | undefined>): string {
  return parts.filter(Boolean).join(":");
}

function planId(plan: SessionPlan, sessionId: string): string {
  const key = plan.markdown?.trim() || plan.agentLabel || sessionId;
  return `plan:${sessionId}:${hashText(`${key}:${iso(plan.timestamp)}`)}`;
}

function addEvent(out: Map<string, NormalizedIntentEvent>, event: NormalizedIntentEvent): void {
  out.set(event.eventId, event);
}

function cleanWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripLogPrefixes(text: string): string {
  return text
    .replace(/^prisma:query\s+/i, "")
    .replace(/^query:\s+/i, "")
    .replace(/^sql:\s+/i, "");
}

function isNoiseText(text: string): boolean {
  const trimmed = cleanWhitespace(text);
  if (!trimmed) return true;
  if (/^prisma:query\b/i.test(trimmed)) return true;
  if (/^(select|insert|update|delete)\b[\s\S]{20,}/i.test(trimmed)) return true;
  if (/^running database migrations/i.test(trimmed)) return true;
  if (/^(\$|>|➜|root@|bash -lc)/.test(trimmed)) return true;
  return false;
}

function sanitizeIntentText(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = stripLogPrefixes(cleanWhitespace(text));
  if (!cleaned || isNoiseText(cleaned)) return null;
  return cleaned;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = sanitizeIntentText(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function buildAgentSnapshotEvents(agent: Agent): NormalizedIntentEvent[] {
  return [{
    eventId: makeEventId(["session-updated", agent.sessionId, agent.status, hashText(agent.currentTask || "")]),
    schemaVersion: "v1",
    source: agent.agentType,
    operatorId: agent.operatorId,
    sessionId: agent.sessionId,
    projectPath: agent.projectPath,
    occurredAt: new Date().toISOString(),
    eventType: "session_updated",
    payload: {
      label: agent.label,
      activityStatus: agent.isActive ? "active" : "idle",
    },
    provenance: {
      signalType: "inferred",
      sourceDetail: sourceDetailForAgent(agent.agentType),
    },
  }];
}

function summarizeUserTurn(turn: TurnNode): string | null {
  return sanitizeIntentText(turn.summary)
    ?? sanitizeIntentText(turn.userInstruction)
    ?? sanitizeIntentText(turn.sections.goal.summary);
}

function summarizeAssistantTurn(turn: TurnNode): string | null {
  return sanitizeIntentText(turn.assistantPreview)
    ?? sanitizeIntentText(turn.sections.approach.summary);
}

function summarizeReasoning(turn: TurnNode): string | null {
  return sanitizeIntentText(turn.sections.approach.thinking)
    ?? sanitizeIntentText(turn.sections.approach.summary);
}

function buildTurnEvents(agent: Agent, parsed: ParsedSession): NormalizedIntentEvent[] {
  const events: NormalizedIntentEvent[] = [];
  const sourceDetail = agent.agentType === "claude" ? "claude_turn_node" : "codex_turn_node";

  for (const turn of parsed.turns) {
    const occurredAt = iso(turn.timestamp);
    const turnId = `${agent.sessionId}:turn:${turn.index}`;

    const userSummary = summarizeUserTurn(turn);
    if (userSummary) {
      events.push({
        eventId: makeEventId(["user-turn", agent.sessionId, turn.index]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "user_turn",
        payload: {
          turnId,
          summary: userSummary,
          category: turn.category,
          instruction: sanitizeIntentText(turn.userInstruction),
        },
        provenance: {
          signalType: "inferred",
          sourceDetail,
        },
      });
    }

    const assistantSummary = summarizeAssistantTurn(turn);
    if (assistantSummary) {
      const assistantPayload: Record<string, unknown> = {
        turnId,
        summary: assistantSummary,
      };
      if (turn.model) {
        assistantPayload.model = turn.model;
      }
      if (
        turn.tokenUsage
        && (
          turn.tokenUsage.inputTokens > 0
          || turn.tokenUsage.outputTokens > 0
          || turn.tokenUsage.cacheReadInputTokens > 0
          || turn.tokenUsage.cacheCreationInputTokens > 0
        )
      ) {
        assistantPayload.tokenUsage = {
          inputTokens: turn.tokenUsage.inputTokens,
          outputTokens: turn.tokenUsage.outputTokens,
          cacheReadInputTokens: turn.tokenUsage.cacheReadInputTokens,
          cacheCreationInputTokens: turn.tokenUsage.cacheCreationInputTokens,
        };
        assistantPayload.cost = computeTurnCost(turn.model, turn.tokenUsage);
      }
      events.push({
        eventId: makeEventId(["assistant-turn", agent.sessionId, turn.index]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "assistant_turn",
        payload: assistantPayload,
        provenance: {
          signalType: "inferred",
          sourceDetail,
        },
      });
    }

    const reasoningSummary = summarizeReasoning(turn);
    if (reasoningSummary) {
      events.push({
        eventId: makeEventId(["reasoning", agent.sessionId, turn.index]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "reasoning_observed",
        payload: {
          turnId,
          reasoningSummary,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: agent.agentType === "claude" ? "claude_thinking" : "codex_reasoning",
        },
      });
    }

    const filesExplored = uniqueStrings([
      ...turn.filesRead,
      ...turn.sections.research.filesRead,
    ]);
    if (filesExplored.length > 0) {
      events.push({
        eventId: makeEventId(["files-explored", agent.sessionId, turn.index, hashText(filesExplored.join("|"))]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "files_explored",
        payload: {
          turnId,
          paths: filesExplored,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail,
        },
      });
    }

    const filesChanged = uniqueStrings([
      ...turn.filesChanged,
      ...turn.sections.artifacts.filesChanged,
    ]);
    if (filesChanged.length > 0) {
      events.push({
        eventId: makeEventId(["files-changed", agent.sessionId, turn.index, hashText(filesChanged.join("|"))]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "files_changed",
        payload: {
          turnId,
          paths: filesChanged,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: agent.agentType === "claude" ? "claude_tool_trace" : "codex_execution_trace",
        },
      });
    }

    const searches = uniqueStrings(turn.sections.research.searches);
    if (searches.length > 0) {
      events.push({
        eventId: makeEventId(["searches", agent.sessionId, turn.index, hashText(searches.join("|"))]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "search_performed",
        payload: {
          turnId,
          queries: searches,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail,
        },
      });
    }

    for (const command of turn.commands.map((value) => cleanWhitespace(value)).filter(Boolean)) {
      events.push({
        eventId: makeEventId(["command", agent.sessionId, turn.index, hashText(command)]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "command_executed",
        payload: {
          turnId,
          command,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: agent.agentType === "claude" ? "claude_tool_trace" : "codex_execution_trace",
        },
      });
    }

    for (const task of turn.taskCreates) {
      const subject = sanitizeIntentText(task.subject);
      if (!subject) continue;
      events.push({
        eventId: makeEventId(["task-created", agent.sessionId, turn.index, task.taskId || hashText(subject)]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "task_created",
        payload: {
          turnId,
          taskId: task.taskId || `task:${hashText(subject)}`,
          subject,
          description: sanitizeIntentText(task.description) ?? "",
        },
        provenance: {
          signalType: agent.agentType === "claude" ? "explicit" : "inferred",
          sourceDetail: agent.agentType === "claude" ? "claude_task_api" : "codex_turn_inference",
        },
      });
    }

    for (const task of turn.taskUpdates) {
      if (!task.taskId) continue;
      events.push({
        eventId: makeEventId(["task-status", agent.sessionId, turn.index, task.taskId, task.status]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "task_updated",
        payload: {
          turnId,
          taskId: task.taskId,
          status: task.status,
        },
        provenance: {
          signalType: agent.agentType === "claude" ? "explicit" : "inferred",
          sourceDetail: agent.agentType === "claude" ? "claude_task_api" : "codex_turn_inference",
        },
      });
    }

    if (turn.hasCommit) {
      events.push({
        eventId: makeEventId(["commit", agent.sessionId, turn.index, hashText(turn.commitMessage || turn.commitSha || turnId)]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "commit_created",
        payload: {
          turnId,
          commitMessage: sanitizeIntentText(turn.commitMessage) ?? null,
          commitSha: turn.commitSha,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: agent.agentType === "claude" ? "claude_tool_trace" : "codex_execution_trace",
        },
      });
    }

    if (turn.hasCompaction) {
      events.push({
        eventId: makeEventId(["compaction", agent.sessionId, turn.index]),
        schemaVersion: "v1",
        source: agent.agentType,
        operatorId: agent.operatorId,
        sessionId: agent.sessionId,
        projectPath: agent.projectPath,
        occurredAt,
        eventType: "compaction",
        payload: {
          turnId,
          summary: sanitizeIntentText(turn.compactionText) ?? "Compaction",
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: "provider_runtime",
        },
      });
    }
  }

  return events;
}

function buildPlanEvents(workstream: Workstream, plan: SessionPlan, agent: Agent | undefined): NormalizedIntentEvent[] {
  const sessionId = agent?.sessionId ?? `${workstream.projectPath}:${plan.agentLabel}`;
  const source = agent?.agentType ?? "claude";
  const operatorId = agent?.operatorId ?? "self";
  const projectPath = workstream.projectPath;
  const occurredAt = iso(plan.timestamp);
  const pid = planId(plan, sessionId);
  const events: NormalizedIntentEvent[] = [];
  const explicit = Boolean(plan.markdown || plan.tasks.length > 0);

  if (plan.status === "drafting") {
    events.push({
      eventId: makeEventId(["plan-started", sessionId, pid]),
      schemaVersion: "v1",
      source,
      operatorId,
      sessionId,
      projectPath,
      occurredAt,
      eventType: "plan_started",
      payload: { planId: pid },
      provenance: {
        signalType: explicit ? "explicit" : "inferred",
        sourceDetail: sourceDetailForAgent(source, explicit),
      },
    });
  }

  if (plan.markdown) {
    events.push({
      eventId: makeEventId(["plan-markdown", sessionId, pid]),
      schemaVersion: "v1",
      source,
      operatorId,
      sessionId,
      projectPath,
      occurredAt,
      eventType: plan.status === "completed" ? "plan_completed" : plan.status === "rejected" ? "plan_rejected" : "plan_updated",
      payload: {
        planId: pid,
        markdown: plan.markdown,
        summary: extractPlanSummary(plan.markdown),
        planDurationMs: plan.planDurationMs,
      },
      provenance: {
        signalType: "explicit",
        sourceDetail: source === "claude" ? "claude_plan_content" : "codex_execution_trace",
      },
    });
  }

  if (plan.draftingActivity?.approachSummary) {
    const approachSummary = sanitizeIntentText(plan.draftingActivity.approachSummary);
    if (approachSummary) {
      events.push({
        eventId: makeEventId(["reasoning", sessionId, pid, hashText(approachSummary)]),
        schemaVersion: "v1",
        source,
        operatorId,
        sessionId,
        projectPath,
        occurredAt: iso(plan.draftingActivity.lastActivityAt),
        eventType: "reasoning_observed",
        payload: {
          reasoningSummary: approachSummary,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: source === "claude" ? "claude_thinking" : "codex_reasoning",
        },
      });
    }
  }

  if (plan.draftingActivity?.filesExplored?.length) {
    const paths = uniqueStrings(plan.draftingActivity.filesExplored);
    if (paths.length > 0) {
      events.push({
        eventId: makeEventId(["files-explored", sessionId, pid, hashText(paths.join("|"))]),
        schemaVersion: "v1",
        source,
        operatorId,
        sessionId,
        projectPath,
        occurredAt: iso(plan.draftingActivity.lastActivityAt),
        eventType: "files_explored",
        payload: {
          paths,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: source === "claude" ? "claude_thinking" : "codex_execution_trace",
        },
      });
    }
  }

  if (plan.draftingActivity?.searches?.length) {
    const queries = uniqueStrings(plan.draftingActivity.searches);
    if (queries.length > 0) {
      events.push({
        eventId: makeEventId(["searches", sessionId, pid, hashText(queries.join("|"))]),
        schemaVersion: "v1",
        source,
        operatorId,
        sessionId,
        projectPath,
        occurredAt: iso(plan.draftingActivity.lastActivityAt),
        eventType: "search_performed",
        payload: {
          queries,
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: source === "claude" ? "claude_thinking" : "codex_execution_trace",
        },
      });
    }
  }

  for (const task of plan.tasks) {
    const subject = sanitizeIntentText(task.subject);
    if (!subject) continue;
    events.push({
      eventId: makeEventId(["task-created", sessionId, task.id || hashText(subject)]),
      schemaVersion: "v1",
      source,
      operatorId,
      sessionId,
      projectPath,
      occurredAt,
      eventType: "task_created",
      payload: {
        taskId: task.id || `task:${hashText(subject)}`,
        subject,
        description: sanitizeIntentText(task.description) ?? "",
        planId: pid,
      },
      provenance: {
        signalType: explicit ? "explicit" : "inferred",
        sourceDetail: source === "claude" ? "claude_task_api" : "codex_execution_trace",
      },
    });
    events.push({
      eventId: makeEventId(["task-status", sessionId, task.id || hashText(subject), task.status]),
      schemaVersion: "v1",
      source,
      operatorId,
      sessionId,
      projectPath,
      occurredAt,
      eventType: "task_updated",
      payload: {
        taskId: task.id || `task:${hashText(subject)}`,
        status: task.status,
        planId: pid,
      },
      provenance: {
        signalType: explicit ? "explicit" : "inferred",
        sourceDetail: source === "claude" ? "claude_task_api" : "codex_execution_trace",
      },
    });
  }

  return events;
}

function buildFeedBackedEvents(feed: FeedEvent, agentBySession: Map<string, Agent>): NormalizedIntentEvent[] {
  const agent = agentBySession.get(feed.sessionId);
  if (!agent) return [];

  const base = {
    schemaVersion: "v1" as const,
    source: agent.agentType,
    operatorId: agent.operatorId,
    sessionId: agent.sessionId,
    projectPath: agent.projectPath,
    occurredAt: iso(feed.timestamp),
  };

  switch (feed.type) {
    case "session_ended":
      return [{
        ...base,
        eventId: makeEventId(["feed-session-ended", feed.id]),
        eventType: "session_ended",
        payload: {
          reason: "completed",
        },
        provenance: {
          signalType: "inferred",
          sourceDetail: "provider_runtime",
        },
      }];
    default:
      return [];
  }
}

function extractPlanSummary(markdown: string): string | null {
  const heading = markdown.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  const first = markdown.split("\n").map((line) => line.trim()).find(Boolean);
  return first ?? null;
}

export function buildIntentEventsForTarget(
  state: DashboardState,
  parsedSessions: ParsedSession[],
  targetProjects: string[],
): NormalizedIntentEvent[] {
  const projectSet = new Set(targetProjects);
  const events = new Map<string, NormalizedIntentEvent>();

  const agents = state.agents.filter((agent) => projectSet.has(agent.projectPath));
  const agentBySession = new Map(agents.map((agent) => [agent.sessionId, agent]));
  const parsedBySession = new Map(
    parsedSessions
      .filter((parsed) => projectSet.has(parsed.session.projectPath))
      .map((parsed) => [parsed.session.id, parsed]),
  );

  for (const agent of agents) {
    for (const event of buildAgentSnapshotEvents(agent)) {
      addEvent(events, event);
    }
    const parsed = parsedBySession.get(agent.sessionId);
    if (parsed) {
      for (const event of buildTurnEvents(agent, parsed)) {
        addEvent(events, event);
      }
    }
  }

  for (const workstream of state.workstreams.filter((ws) => projectSet.has(ws.projectPath))) {
    const agentByLabel = new Map(workstream.agents.map((agent) => [agent.label, agent]));
    for (const plan of workstream.plans) {
      const planAgent = agentByLabel.get(plan.agentLabel);
      for (const event of buildPlanEvents(workstream, plan, planAgent)) {
        addEvent(events, event);
      }
    }
  }

  for (const feed of state.feed.filter((event) => projectSet.has(event.projectPath))) {
    for (const event of buildFeedBackedEvents(feed, agentBySession)) {
      addEvent(events, event);
    }
  }

  return [...events.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
}

import { createHash } from "node:crypto";
import type {
  Agent,
  DashboardState,
  ParsedSession,
} from "../types/index.js";
import { getLastKnownBranch } from "../core/git-state.js";

export type IntentEventSource = "claude" | "codex";
export type IntentEventType =
  | "session_started"
  | "session_updated"
  | "files_explored"
  | "files_changed"
  | "command_executed"
  | "commit_created";

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

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / token auth headers
  [/(Bearer\s+)[A-Za-z0-9\-_\.]{8,}/gi, "$1[REDACTED]"],
  // AWS access key IDs
  [/\b(AKIA[0-9A-Z]{12,})/g, "[REDACTED_AWS_KEY]"],
  // AWS secret keys (40 char base64)
  [/(?<=AWS_SECRET_ACCESS_KEY[=:]\s*["']?)[A-Za-z0-9\/+=]{30,}/g, "[REDACTED]"],
  // Generic secret/key/token/password env assignments: export VAR=value or VAR=value
  [/((?:SECRET|TOKEN|PASSWORD|API_KEY|APIKEY|AUTH|CREDENTIALS?|PRIVATE_KEY)[=:]\s*["']?)([^\s"']{4,})/gi, "$1[REDACTED]"],
  // Connection strings with passwords: postgres://user:pass@host, mysql://user:pass@host
  [/((?:postgres|mysql|mongodb|redis|amqp|mssql)(?:ql)?:\/\/[^:]+:)[^@]+(@)/gi, "$1[REDACTED]$2"],
  // -p flag for mysql/psql (e.g. mysql -u root -pMyPassword)
  [/(-p)([^\s]{4,})/g, "$1[REDACTED]"],
  // curl -u user:pass
  [/(-u\s+\S+:)\S+/g, "$1[REDACTED]"],
  // Authorization header values in curl -H
  [/(-H\s+["']Authorization:\s*(?:Basic|Digest)\s+)[A-Za-z0-9+\/=]+/gi, "$1[REDACTED]"],
];

function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
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
  const gitBranch = getLastKnownBranch(agent.projectPath);
  const now = new Date().toISOString();
  return [
    {
      eventId: makeEventId(["session-started", agent.sessionId, gitBranch ?? "no-branch"]),
      schemaVersion: "v1",
      source: agent.agentType,
      operatorId: agent.operatorId,
      sessionId: agent.sessionId,
      projectPath: agent.projectPath,
      occurredAt: now,
      eventType: "session_started",
      payload: {
        label: agent.label,
        ...(gitBranch ? { gitBranch } : {}),
      },
      provenance: {
        signalType: "inferred",
        sourceDetail: sourceDetailForAgent(agent.agentType),
      },
    },
    {
      eventId: makeEventId(["session-updated", agent.sessionId, agent.status, gitBranch ?? "no-branch", hashText(agent.currentTask || "")]),
      schemaVersion: "v1",
      source: agent.agentType,
      operatorId: agent.operatorId,
      sessionId: agent.sessionId,
      projectPath: agent.projectPath,
      occurredAt: now,
      eventType: "session_updated",
      payload: {
        label: agent.label,
        activityStatus: agent.isActive ? "active" : "idle",
        ...(gitBranch ? { gitBranch } : {}),
      },
      provenance: {
        signalType: "inferred",
        sourceDetail: sourceDetailForAgent(agent.agentType),
      },
    },
  ];
}

function buildTurnEvents(agent: Agent, parsed: ParsedSession): NormalizedIntentEvent[] {
  const events: NormalizedIntentEvent[] = [];
  const sourceDetail = agent.agentType === "claude" ? "claude_turn_node" : "codex_turn_node";

  for (const turn of parsed.turns) {
    const occurredAt = iso(turn.timestamp);
    const turnId = `${agent.sessionId}:turn:${turn.index}`;

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

    for (const rawCommand of turn.commands.map((value) => cleanWhitespace(value)).filter(Boolean)) {
      const command = redactSecrets(rawCommand);
      events.push({
        eventId: makeEventId(["command", agent.sessionId, turn.index, hashText(rawCommand)]),
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
  }

  return events;
}

export function buildIntentEventsForTarget(
  state: DashboardState,
  parsedSessions: ParsedSession[],
  targetProjects: string[],
): NormalizedIntentEvent[] {
  const projectSet = new Set(targetProjects);
  const events = new Map<string, NormalizedIntentEvent>();

  const agents = state.agents.filter((agent) => projectSet.has(agent.projectPath));
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

  return [...events.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
}

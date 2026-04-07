import { listStoredClaudeSessions, type StoredSessionRow } from "../storage/repositories.js";
import { listStoredSessionState, type SessionStateRow } from "../storage/session-state.js";
import {
  listStoredTasks,
  listStoredSessionTasks,
  listStoredTaskEvidence,
  type TaskEvidenceRow,
  type TaskRow,
  type SessionTaskRow,
} from "../storage/tasks.js";
import {
  listStoredWorkstreams,
  listStoredWorkstreamTasks,
  listStoredWorkstreamSessions,
  listStoredWorkstreamEvidence,
  listStoredWorkstreamState,
  listStoredTaskModuleAffinities,
  type WorkstreamEvidenceRow,
  type WorkstreamRow,
  type WorkstreamStateRow,
  type WorkstreamTaskRow,
  type WorkstreamSessionRow,
  type TaskModuleAffinityRow,
} from "../storage/workstreams.js";
import {
  listStoredArtifacts,
  listStoredTaskArtifacts,
  listStoredSessionArtifacts,
  listStoredWorkstreamArtifacts,
  listStoredDecisions,
  listStoredDecisionEvidence,
  listStoredTaskDecisions,
  listStoredSessionDecisions,
  listStoredWorkstreamDecisions,
  listStoredBlockers,
  listStoredBlockerEvidence,
  listStoredTaskBlockers,
  listStoredSessionBlockers,
  listStoredWorkstreamBlockers,
  type ArtifactAttachmentRow,
  type ArtifactRow,
  type DecisionAttachmentRow,
  type DecisionEvidenceRow,
  type DecisionRow,
  type BlockerAttachmentRow,
  type BlockerEvidenceRow,
  type BlockerRow,
} from "../storage/m6.js";
import {
  listStoredHandoffs,
  listStoredHandoffWorkstreams,
  type HandoffAttachmentRow,
  type HandoffRow,
} from "../storage/handoffs.js";

export interface ControlState {
  generatedAt: string;
  workstreams: ControlWorkstream[];
}

export interface ControlWorkstream {
  id: string;
  projectPath: string;
  canonicalKey: string;
  title: string;
  summary: string | null;
  status: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  counts: {
    tasks: number;
    sessions: number;
    handoffs: number;
    blockers: number;
    decisions: number;
    artifacts: number;
  };
  state: WorkstreamStateRow | null;
  evidence: WorkstreamEvidenceRow[];
  tasks: ControlTask[];
  sessions: ControlSession[];
  handoffs: ControlHandoff[];
  blockers: ControlBlocker[];
  decisions: ControlDecision[];
  artifacts: ControlArtifact[];
}

export interface ControlTask {
  row: TaskRow;
  groupingBasis: string[];
  sessions: Array<{
    sessionId: string;
    relationshipType: string;
    confidence: number;
  }>;
  evidence: TaskEvidenceRow[];
  moduleAffinities: TaskModuleAffinityRow[];
  blockers: ControlBlocker[];
  decisions: ControlDecision[];
  artifacts: ControlArtifact[];
}

export interface ControlSession {
  row: StoredSessionRow;
  state: SessionStateRow | null;
  filesInPlay: string[];
  tasks: Array<{
    taskId: string;
    relationshipType: string;
    confidence: number;
  }>;
  handoff: ControlHandoff | null;
  blockers: ControlBlocker[];
  decisions: ControlDecision[];
  artifacts: ControlArtifact[];
}

export interface ControlArtifact {
  row: ArtifactRow;
  attachments: {
    taskIds: string[];
    sessionIds: string[];
    workstreamIds: string[];
  };
}

export interface ControlDecision {
  row: DecisionRow;
  evidence: DecisionEvidenceRow[];
  attachments: {
    taskIds: string[];
    sessionIds: string[];
    workstreamIds: string[];
  };
}

export interface ControlBlocker {
  row: BlockerRow;
  evidence: BlockerEvidenceRow[];
  attachments: {
    taskIds: string[];
    sessionIds: string[];
    workstreamIds: string[];
  };
}

export interface ControlHandoff {
  row: HandoffRow;
  openQuestions: string[];
  nextSteps: string[];
  filesInPlay: string[];
  resumePackage: Record<string, unknown> | null;
}

export function buildControlState(): ControlState {
  // TODO(M8 Phase B): replace this full in-memory assembly with dedicated,
  // narrower read-model queries once the inspection surface stabilizes.
  const workstreams = listStoredWorkstreams();
  const workstreamTasks = listStoredWorkstreamTasks();
  const workstreamSessions = listStoredWorkstreamSessions();
  const workstreamEvidence = listStoredWorkstreamEvidence();
  const workstreamState = listStoredWorkstreamState();

  const tasks = listStoredTasks();
  const sessionTasks = listStoredSessionTasks();
  const taskEvidence = listStoredTaskEvidence();
  const taskModuleAffinities = listStoredTaskModuleAffinities();

  const sessions = listStoredClaudeSessions();
  const sessionState = listStoredSessionState();

  const artifacts = listStoredArtifacts();
  const taskArtifacts = listStoredTaskArtifacts();
  const sessionArtifacts = listStoredSessionArtifacts();
  const workstreamArtifacts = listStoredWorkstreamArtifacts();

  const decisions = listStoredDecisions();
  const decisionEvidence = listStoredDecisionEvidence();
  const taskDecisions = listStoredTaskDecisions();
  const sessionDecisions = listStoredSessionDecisions();
  const workstreamDecisions = listStoredWorkstreamDecisions();

  const blockers = listStoredBlockers();
  const blockerEvidence = listStoredBlockerEvidence();
  const taskBlockers = listStoredTaskBlockers();
  const sessionBlockers = listStoredSessionBlockers();
  const workstreamBlockers = listStoredWorkstreamBlockers();

  const handoffs = listStoredHandoffs();
  const handoffWorkstreams = listStoredHandoffWorkstreams();

  const sessionById = new Map(sessions.map((row) => [row.id, row]));
  const sessionStateById = new Map(sessionState.map((row) => [row.sessionId, row]));
  const taskById = new Map(tasks.map((row) => [row.id, row]));
  const artifactById = new Map(artifacts.map((row) => [row.id, row]));
  const decisionById = new Map(decisions.map((row) => [row.id, row]));
  const blockerById = new Map(blockers.map((row) => [row.id, row]));
  const handoffById = new Map(handoffs.map((row) => [row.id, row]));

  const workstreamTasksById = groupBy(workstreamTasks, (row) => row.workstreamId);
  const workstreamSessionsById = groupBy(workstreamSessions, (row) => row.workstreamId);
  const workstreamEvidenceById = groupBy(workstreamEvidence, (row) => row.workstreamId);
  const workstreamStateById = new Map(workstreamState.map((row) => [row.workstreamId, row]));
  const sessionTasksBySessionId = groupBy(sessionTasks, (row) => row.sessionId);
  const sessionTasksByTaskId = groupBy(sessionTasks, (row) => row.taskId);
  const taskEvidenceByTaskId = groupBy(taskEvidence, (row) => row.taskId);
  const taskModuleAffinitiesByTaskId = groupBy(taskModuleAffinities, (row) => row.taskId);
  const handoffWorkstreamsByWorkstreamId = groupBy(handoffWorkstreams, (row) => row.ownerId);
  const handoffBySessionId = new Map(handoffs.map((row) => [row.sessionId, row]));

  const taskArtifactsByTaskId = groupBy(taskArtifacts, (row) => row.ownerId);
  const sessionArtifactsBySessionId = groupBy(sessionArtifacts, (row) => row.ownerId);
  const workstreamArtifactsByWorkstreamId = groupBy(workstreamArtifacts, (row) => row.ownerId);
  const taskDecisionsByTaskId = groupBy(taskDecisions, (row) => row.ownerId);
  const sessionDecisionsBySessionId = groupBy(sessionDecisions, (row) => row.ownerId);
  const workstreamDecisionsByWorkstreamId = groupBy(workstreamDecisions, (row) => row.ownerId);
  const taskBlockersByTaskId = groupBy(taskBlockers, (row) => row.ownerId);
  const sessionBlockersBySessionId = groupBy(sessionBlockers, (row) => row.ownerId);
  const workstreamBlockersByWorkstreamId = groupBy(workstreamBlockers, (row) => row.ownerId);
  const decisionEvidenceByDecisionId = groupBy(decisionEvidence, (row) => row.decisionId);
  const blockerEvidenceByBlockerId = groupBy(blockerEvidence, (row) => row.blockerId);

  const controlWorkstreams = workstreams
    .map((workstream) => {
      const taskLinks = workstreamTasksById.get(workstream.id) ?? [];
      const sessionLinks = workstreamSessionsById.get(workstream.id) ?? [];
      const wsEvidence = workstreamEvidenceById.get(workstream.id) ?? [];
      const wsState = workstreamStateById.get(workstream.id) ?? null;

      const wsTasks = taskLinks
        .map((link) => buildControlTask(
          link.taskId,
          taskById,
          sessionTasksByTaskId,
          taskEvidenceByTaskId,
          taskModuleAffinitiesByTaskId,
          taskArtifactsByTaskId,
          taskDecisionsByTaskId,
          taskBlockersByTaskId,
          artifactById,
          decisionById,
          blockerById,
          decisionEvidenceByDecisionId,
          blockerEvidenceByBlockerId,
          taskLinks.filter((row) => row.taskId === link.taskId),
          taskArtifacts,
          sessionArtifacts,
          workstreamArtifacts,
        ))
        .filter((row): row is ControlTask => Boolean(row))
        .sort((a, b) => rankTask(a.row) - rankTask(b.row) || compareDesc(a.row.updatedAt, b.row.updatedAt));

      const wsSessions = sessionLinks
        .map((link) => buildControlSession(
          link.sessionId,
          sessionById,
          sessionStateById,
          sessionTasksBySessionId,
          handoffBySessionId,
          sessionArtifactsBySessionId,
          sessionDecisionsBySessionId,
          sessionBlockersBySessionId,
          artifactById,
          decisionById,
          blockerById,
          decisionEvidenceByDecisionId,
          blockerEvidenceByBlockerId,
          taskArtifacts,
          sessionArtifacts,
          workstreamArtifacts,
        ))
        .filter((row): row is ControlSession => Boolean(row))
        .sort((a, b) => rankSession(a) - rankSession(b) || compareDesc(a.state?.lastEventAt ?? null, b.state?.lastEventAt ?? null));

      const wsHandoffs = (handoffWorkstreamsByWorkstreamId.get(workstream.id) ?? [])
        .map((link) => handoffById.get(link.handoffId))
        .filter((row): row is HandoffRow => Boolean(row))
        .map(buildControlHandoff)
        .sort((a, b) => compareDesc(a.row.lastEventAt, b.row.lastEventAt));

      const wsBlockers = buildControlBlockers(workstreamBlockersByWorkstreamId.get(workstream.id) ?? [], blockerById, blockerEvidenceByBlockerId);
      const wsDecisions = buildControlDecisions(workstreamDecisionsByWorkstreamId.get(workstream.id) ?? [], decisionById, decisionEvidenceByDecisionId);
      const wsArtifacts = buildControlArtifacts(workstreamArtifactsByWorkstreamId.get(workstream.id) ?? [], artifactById, taskArtifacts, sessionArtifacts, workstreamArtifacts);

      return {
        id: workstream.id,
        projectPath: workstream.projectPath,
        canonicalKey: workstream.canonicalKey,
        title: workstream.title,
        summary: workstream.summary,
        status: workstream.status,
        confidence: workstream.confidence,
        createdAt: workstream.createdAt,
        updatedAt: workstream.updatedAt,
        lastActivityAt: wsState?.lastActivityAt ?? null,
        counts: {
          tasks: wsTasks.length,
          sessions: wsSessions.length,
          handoffs: wsHandoffs.length,
          blockers: wsBlockers.length,
          decisions: wsDecisions.length,
          artifacts: wsArtifacts.length,
        },
        state: wsState,
        evidence: wsEvidence.slice(0, 12),
        tasks: wsTasks,
        sessions: wsSessions,
        handoffs: wsHandoffs,
        blockers: wsBlockers,
        decisions: wsDecisions,
        artifacts: wsArtifacts,
      } satisfies ControlWorkstream;
    })
    .sort((a, b) => rankWorkstream(a) - rankWorkstream(b) || compareDesc(a.lastActivityAt, b.lastActivityAt));

  return {
    generatedAt: new Date().toISOString(),
    workstreams: controlWorkstreams,
  };
}

function buildControlTask(
  taskId: string,
  taskById: Map<string, TaskRow>,
  sessionTasksByTaskId: Map<string, SessionTaskRow[]>,
  taskEvidenceByTaskId: Map<string, TaskEvidenceRow[]>,
  taskModuleAffinitiesByTaskId: Map<string, TaskModuleAffinityRow[]>,
  taskArtifactsByTaskId: Map<string, ArtifactAttachmentRow[]>,
  taskDecisionsByTaskId: Map<string, DecisionAttachmentRow[]>,
  taskBlockersByTaskId: Map<string, BlockerAttachmentRow[]>,
  artifactById: Map<string, ArtifactRow>,
  decisionById: Map<string, DecisionRow>,
  blockerById: Map<string, BlockerRow>,
  decisionEvidenceByDecisionId: Map<string, DecisionEvidenceRow[]>,
  blockerEvidenceByBlockerId: Map<string, BlockerEvidenceRow[]>,
  workstreamTaskLinks: WorkstreamTaskRow[],
  taskArtifacts: ArtifactAttachmentRow[],
  sessionArtifacts: ArtifactAttachmentRow[],
  workstreamArtifacts: ArtifactAttachmentRow[],
): ControlTask | null {
  const row = taskById.get(taskId);
  if (!row) return null;
  return {
    row,
    groupingBasis: [...new Set(workstreamTaskLinks.map((link) => link.groupingBasis))],
    sessions: (sessionTasksByTaskId.get(taskId) ?? []).map((link) => ({
      sessionId: link.sessionId,
      relationshipType: link.relationshipType,
      confidence: link.confidence,
    })),
    evidence: (taskEvidenceByTaskId.get(taskId) ?? []).slice(0, 12),
    moduleAffinities: (taskModuleAffinitiesByTaskId.get(taskId) ?? []).sort((a, b) => b.score - a.score),
    blockers: buildControlBlockers(taskBlockersByTaskId.get(taskId) ?? [], blockerById, blockerEvidenceByBlockerId),
    decisions: buildControlDecisions(taskDecisionsByTaskId.get(taskId) ?? [], decisionById, decisionEvidenceByDecisionId),
    artifacts: buildControlArtifacts(taskArtifactsByTaskId.get(taskId) ?? [], artifactById, taskArtifacts, sessionArtifacts, workstreamArtifacts),
  };
}

function buildControlSession(
  sessionId: string,
  sessionById: Map<string, StoredSessionRow>,
  sessionStateById: Map<string, SessionStateRow>,
  sessionTasksBySessionId: Map<string, SessionTaskRow[]>,
  handoffBySessionId: Map<string, HandoffRow>,
  sessionArtifactsBySessionId: Map<string, ArtifactAttachmentRow[]>,
  sessionDecisionsBySessionId: Map<string, DecisionAttachmentRow[]>,
  sessionBlockersBySessionId: Map<string, BlockerAttachmentRow[]>,
  artifactById: Map<string, ArtifactRow>,
  decisionById: Map<string, DecisionRow>,
  blockerById: Map<string, BlockerRow>,
  decisionEvidenceByDecisionId: Map<string, DecisionEvidenceRow[]>,
  blockerEvidenceByBlockerId: Map<string, BlockerEvidenceRow[]>,
  taskArtifacts: ArtifactAttachmentRow[],
  sessionArtifacts: ArtifactAttachmentRow[],
  workstreamArtifacts: ArtifactAttachmentRow[],
): ControlSession | null {
  const row = sessionById.get(sessionId);
  if (!row) return null;
  const state = sessionStateById.get(sessionId) ?? null;
  return {
    row,
    state,
    filesInPlay: safeParseStringArray(state?.filesInPlayJson ?? "[]"),
    tasks: (sessionTasksBySessionId.get(sessionId) ?? []).map((link) => ({
      taskId: link.taskId,
      relationshipType: link.relationshipType,
      confidence: link.confidence,
    })),
    handoff: handoffBySessionId.has(sessionId) ? buildControlHandoff(handoffBySessionId.get(sessionId)!) : null,
    blockers: buildControlBlockers(sessionBlockersBySessionId.get(sessionId) ?? [], blockerById, blockerEvidenceByBlockerId),
    decisions: buildControlDecisions(sessionDecisionsBySessionId.get(sessionId) ?? [], decisionById, decisionEvidenceByDecisionId),
    artifacts: buildControlArtifacts(sessionArtifactsBySessionId.get(sessionId) ?? [], artifactById, taskArtifacts, sessionArtifacts, workstreamArtifacts),
  };
}

function buildControlArtifacts(
  links: ArtifactAttachmentRow[],
  artifactById: Map<string, ArtifactRow>,
  taskArtifacts: ArtifactAttachmentRow[] = [],
  sessionArtifacts: ArtifactAttachmentRow[] = [],
  workstreamArtifacts: ArtifactAttachmentRow[] = [],
): ControlArtifact[] {
  return dedupeBy(
    links
      .map((link) => artifactById.get(link.artifactId))
      .filter((row): row is ArtifactRow => Boolean(row))
      .map((row) => ({
        row,
        attachments: {
          taskIds: taskArtifacts.filter((link) => link.artifactId === row.id).map((link) => link.ownerId),
          sessionIds: sessionArtifacts.filter((link) => link.artifactId === row.id).map((link) => link.ownerId),
          workstreamIds: workstreamArtifacts.filter((link) => link.artifactId === row.id).map((link) => link.ownerId),
        },
      })),
    (row) => row.row.id,
  );
}

function buildControlDecisions(
  links: DecisionAttachmentRow[],
  decisionById: Map<string, DecisionRow>,
  decisionEvidenceByDecisionId: Map<string, DecisionEvidenceRow[]>,
): ControlDecision[] {
  return dedupeBy(
    links
      .map((link) => decisionById.get(link.decisionId))
      .filter((row): row is DecisionRow => Boolean(row))
      .map((row) => ({
        row,
        evidence: (decisionEvidenceByDecisionId.get(row.id) ?? []).slice(0, 8),
        attachments: {
          taskIds: [],
          sessionIds: [],
          workstreamIds: [],
        },
      })),
    (row) => row.row.id,
  );
}

function buildControlBlockers(
  links: BlockerAttachmentRow[],
  blockerById: Map<string, BlockerRow>,
  blockerEvidenceByBlockerId: Map<string, BlockerEvidenceRow[]>,
): ControlBlocker[] {
  return dedupeBy(
    links
      .map((link) => blockerById.get(link.blockerId))
      .filter((row): row is BlockerRow => Boolean(row))
      .map((row) => ({
        row,
        evidence: (blockerEvidenceByBlockerId.get(row.id) ?? []).slice(0, 8),
        attachments: {
          taskIds: [],
          sessionIds: [],
          workstreamIds: [],
        },
      })),
    (row) => row.row.id,
  );
}

function buildControlHandoff(row: HandoffRow): ControlHandoff {
  return {
    row,
    openQuestions: safeParseStringArray(row.openQuestionsJson),
    nextSteps: safeParseStringArray(row.nextStepsJson),
    filesInPlay: safeParseStringArray(row.filesInPlayJson),
    resumePackage: safeParseObject(row.resumePackageJson),
  };
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const current = map.get(key);
    if (current) current.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function dedupeBy<T>(rows: T[], keyFn: (row: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function compareDesc(a: string | null, b: string | null): number {
  const aTime = a ? Date.parse(a) : 0;
  const bTime = b ? Date.parse(b) : 0;
  return bTime - aTime;
}

function rankWorkstream(workstream: ControlWorkstream): number {
  if (workstream.status === "blocked") return 0;
  if (workstream.counts.handoffs > 0) return 1;
  if (workstream.status === "stalled") return 2;
  if (workstream.status === "in_progress") return 3;
  return 4;
}

function rankTask(task: TaskRow): number {
  if (task.status === "blocked") return 0;
  if (task.status === "stalled") return 1;
  if (task.status === "in_progress") return 2;
  if (task.status === "pending") return 3;
  return 4;
}

function rankSession(session: ControlSession): number {
  if (session.state?.status === "blocked") return 0;
  if (session.handoff) return 1;
  if (session.state?.status === "stalled") return 2;
  if (session.state?.status === "in_progress") return 3;
  return 4;
}

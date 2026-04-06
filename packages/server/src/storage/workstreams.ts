import { createHash } from "node:crypto";
import { basename } from "node:path";
import { getDb } from "./db.js";
import type { TaskStatus } from "./tasks.js";

export type WorkstreamStatus = "pending" | "in_progress" | "blocked" | "stalled" | "completed";

export interface WorkstreamRow {
  id: string;
  projectPath: string;
  canonicalKey: string;
  title: string;
  summary: string | null;
  status: WorkstreamStatus;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  metadataJson: string | null;
}

export interface WorkstreamTaskRow {
  workstreamId: string;
  taskId: string;
  confidence: number;
  derivedAt: string;
}

export interface WorkstreamSessionRow {
  workstreamId: string;
  sessionId: string;
  relationshipType: string;
  confidence: number;
  derivedAt: string;
}

export interface WorkstreamEvidenceRow {
  workstreamId: string;
  evidenceType: string;
  sourceTable: string;
  sourceRowId: string | null;
  snippet: string | null;
  confidence: number;
  createdAt: string;
}

export interface WorkstreamStateRow {
  workstreamId: string;
  derivedAt: string;
  status: WorkstreamStatus;
  summary: string;
  activeTaskCount: number;
  blockedTaskCount: number;
  stalledTaskCount: number;
  completedTaskCount: number;
  sessionCount: number;
  confidence: number;
  lastActivityAt: string | null;
}

interface ProjectTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  confidence: number;
  updatedAt: string;
}

interface ProjectSessionRow {
  id: string;
  lastEventAt: string | null;
}

interface SessionStateRow {
  sessionId: string;
  currentGoal: string;
  status: string;
}

interface TaskEvidenceSnippetRow {
  taskId: string;
  evidenceType: string;
  sourceTable: string;
  sourceRowId: string | null;
  snippet: string | null;
  confidence: number;
}

export function deriveAndStoreWorkstreamsForProject(projectPath: string): void {
  const db = getDb();
  // V1 simplification: one durable workstream per project. This gives us a
  // stable ontology above tasks now; finer task clustering within a project can
  // replace this project-scoped grouping later.
  const tasks = db.prepare(`
    SELECT
      id,
      title,
      status,
      confidence,
      updated_at as updatedAt
    FROM tasks
    WHERE project_path = ?
    ORDER BY updated_at DESC, title ASC
  `).all(projectPath) as ProjectTaskRow[];
  const sessions = db.prepare(`
    SELECT
      id,
      last_event_at as lastEventAt
    FROM sessions
    WHERE project_path = ?
    ORDER BY last_event_at DESC
  `).all(projectPath) as ProjectSessionRow[];

  if (tasks.length === 0 && sessions.length === 0) {
    cleanupProjectWorkstream(projectPath);
    return;
  }

  const sessionState = db.prepare(`
    SELECT
      session_state.session_id as sessionId,
      session_state.current_goal as currentGoal,
      session_state.status as status
    FROM session_state
    JOIN sessions ON sessions.id = session_state.session_id
    WHERE sessions.project_path = ?
    ORDER BY session_state.last_event_at DESC
  `).all(projectPath) as SessionStateRow[];

  const taskEvidence = tasks.length > 0
    ? db.prepare(`
        SELECT
          task_id as taskId,
          evidence_type as evidenceType,
          source_table as sourceTable,
          source_row_id as sourceRowId,
          snippet,
          confidence
        FROM task_evidence
        WHERE task_id IN (${tasks.map(() => "?").join(", ")})
        ORDER BY created_at DESC, id DESC
      `).all(...tasks.map((task) => task.id)) as TaskEvidenceSnippetRow[]
    : [];

  const workstreamId = makeWorkstreamId(projectPath);
  const title = deriveWorkstreamTitle(projectPath, tasks);
  const summary = deriveWorkstreamSummary(tasks, sessionState);
  const confidence = deriveWorkstreamConfidence(tasks);
  const now = new Date().toISOString();
  const status = deriveWorkstreamStatus(tasks);
  const lastActivityAt = deriveLastActivityAt(tasks, sessions);

  db.prepare(`
    INSERT INTO workstreams(
      id, project_path, canonical_key, title, summary, status, confidence, created_at, updated_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_path) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      status = excluded.status,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at,
      metadata_json = excluded.metadata_json
  `).run(
    workstreamId,
    projectPath,
    projectPath,
    title,
    summary,
    status,
    confidence,
    now,
    now,
    JSON.stringify({
      projectName: basename(projectPath) || projectPath,
      taskCount: tasks.length,
      sessionCount: sessions.length,
    }),
  );

  db.prepare(`DELETE FROM workstream_tasks WHERE workstream_id = ?`).run(workstreamId);
  db.prepare(`DELETE FROM workstream_sessions WHERE workstream_id = ?`).run(workstreamId);
  db.prepare(`DELETE FROM workstream_evidence WHERE workstream_id = ?`).run(workstreamId);

  for (const task of tasks) {
    db.prepare(`
      INSERT INTO workstream_tasks(workstream_id, task_id, confidence, derived_at)
      VALUES (?, ?, ?, ?)
    `).run(workstreamId, task.id, task.confidence, now);
  }

  for (const session of sessions) {
    const relationshipType = sessionState.some((row) => row.sessionId === session.id && row.status === "completed")
      ? "supporting"
      : "active";
    db.prepare(`
      INSERT INTO workstream_sessions(workstream_id, session_id, relationship_type, confidence, derived_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workstreamId, session.id, relationshipType, 0.9, now);
  }

  const insertedTaskEvidenceIds = new Set<string>();
  for (const evidence of taskEvidence.slice(0, 6)) {
    const key = `${evidence.taskId}:${evidence.evidenceType}:${evidence.snippet ?? ""}`;
    if (insertedTaskEvidenceIds.has(key)) continue;
    insertedTaskEvidenceIds.add(key);
    db.prepare(`
      INSERT INTO workstream_evidence(workstream_id, evidence_type, source_table, source_row_id, snippet, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      workstreamId,
      evidence.evidenceType,
      evidence.sourceTable,
      evidence.sourceRowId,
      evidence.snippet,
      evidence.confidence,
      now,
    );
  }

  for (const session of sessionState.slice(0, 3)) {
    db.prepare(`
      INSERT INTO workstream_evidence(workstream_id, evidence_type, source_table, source_row_id, snippet, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      workstreamId,
      "session_goal",
      "session_state",
      session.sessionId,
      session.currentGoal,
      0.64,
      now,
    );
  }

  const counts = countTaskStatuses(tasks);
  db.prepare(`
    INSERT INTO workstream_state(
      workstream_id, derived_at, status, summary, active_task_count, blocked_task_count, stalled_task_count,
      completed_task_count, session_count, confidence, last_activity_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workstream_id) DO UPDATE SET
      derived_at = excluded.derived_at,
      status = excluded.status,
      summary = excluded.summary,
      active_task_count = excluded.active_task_count,
      blocked_task_count = excluded.blocked_task_count,
      stalled_task_count = excluded.stalled_task_count,
      completed_task_count = excluded.completed_task_count,
      session_count = excluded.session_count,
      confidence = excluded.confidence,
      last_activity_at = excluded.last_activity_at
  `).run(
    workstreamId,
    now,
    status,
    summary,
    counts.inProgress + counts.pending,
    counts.blocked,
    counts.stalled,
    counts.completed,
    sessions.length,
    confidence,
    lastActivityAt,
  );
}

export function listStoredWorkstreams(projectPath?: string): WorkstreamRow[] {
  const db = getDb();
  const sql = `
    SELECT
      id,
      project_path as projectPath,
      canonical_key as canonicalKey,
      title,
      summary,
      status,
      confidence,
      created_at as createdAt,
      updated_at as updatedAt,
      metadata_json as metadataJson
    FROM workstreams
    ${projectPath ? "WHERE project_path = ?" : ""}
    ORDER BY updated_at DESC, title ASC
  `;
  return (projectPath ? db.prepare(sql).all(projectPath) : db.prepare(sql).all()) as WorkstreamRow[];
}

export function listStoredWorkstreamTasks(workstreamId?: string): WorkstreamTaskRow[] {
  const db = getDb();
  const sql = `
    SELECT
      workstream_id as workstreamId,
      task_id as taskId,
      confidence,
      derived_at as derivedAt
    FROM workstream_tasks
    ${workstreamId ? "WHERE workstream_id = ?" : ""}
    ORDER BY derived_at DESC, task_id ASC
  `;
  return (workstreamId ? db.prepare(sql).all(workstreamId) : db.prepare(sql).all()) as WorkstreamTaskRow[];
}

export function listStoredWorkstreamSessions(workstreamId?: string): WorkstreamSessionRow[] {
  const db = getDb();
  const sql = `
    SELECT
      workstream_id as workstreamId,
      session_id as sessionId,
      relationship_type as relationshipType,
      confidence,
      derived_at as derivedAt
    FROM workstream_sessions
    ${workstreamId ? "WHERE workstream_id = ?" : ""}
    ORDER BY derived_at DESC, session_id ASC
  `;
  return (workstreamId ? db.prepare(sql).all(workstreamId) : db.prepare(sql).all()) as WorkstreamSessionRow[];
}

export function listStoredWorkstreamEvidence(workstreamId?: string): WorkstreamEvidenceRow[] {
  const db = getDb();
  const sql = `
    SELECT
      workstream_id as workstreamId,
      evidence_type as evidenceType,
      source_table as sourceTable,
      source_row_id as sourceRowId,
      snippet,
      confidence,
      created_at as createdAt
    FROM workstream_evidence
    ${workstreamId ? "WHERE workstream_id = ?" : ""}
    ORDER BY created_at DESC, id DESC
  `;
  return (workstreamId ? db.prepare(sql).all(workstreamId) : db.prepare(sql).all()) as WorkstreamEvidenceRow[];
}

export function listStoredWorkstreamState(workstreamId?: string): WorkstreamStateRow[] {
  const db = getDb();
  const sql = `
    SELECT
      workstream_id as workstreamId,
      derived_at as derivedAt,
      status,
      summary,
      active_task_count as activeTaskCount,
      blocked_task_count as blockedTaskCount,
      stalled_task_count as stalledTaskCount,
      completed_task_count as completedTaskCount,
      session_count as sessionCount,
      confidence,
      last_activity_at as lastActivityAt
    FROM workstream_state
    ${workstreamId ? "WHERE workstream_id = ?" : ""}
    ORDER BY last_activity_at DESC, workstream_id ASC
  `;
  return (workstreamId ? db.prepare(sql).all(workstreamId) : db.prepare(sql).all()) as WorkstreamStateRow[];
}

function cleanupProjectWorkstream(projectPath: string): void {
  const db = getDb();
  const row = db.prepare(`SELECT id FROM workstreams WHERE project_path = ?`).get(projectPath) as { id?: string } | undefined;
  if (!row?.id) return;
  db.prepare(`DELETE FROM workstreams WHERE id = ?`).run(row.id);
}

function deriveWorkstreamTitle(projectPath: string, tasks: ProjectTaskRow[]): string {
  const projectName = basename(projectPath) || projectPath;
  if (tasks.length === 0) return projectName;
  const top = tasks.slice(0, 2).map((task) => task.title);
  if (top.length === 1) return `${projectName}: ${top[0]}`;
  return `${projectName}: ${top[0]} + ${tasks.length - 1} more`;
}

function deriveWorkstreamSummary(tasks: ProjectTaskRow[], sessionState: SessionStateRow[]): string {
  const taskPart = tasks.length > 0
    ? `Tasks: ${tasks.slice(0, 3).map((task) => task.title).join("; ")}`
    : "No derived tasks";
  const goalPart = sessionState.length > 0
    ? `Current goals: ${sessionState.slice(0, 2).map((row) => row.currentGoal).join("; ")}`
    : "No active session goals";
  return `${taskPart}. ${goalPart}`;
}

function deriveWorkstreamConfidence(tasks: ProjectTaskRow[]): number {
  if (tasks.length === 0) return 0.45;
  const avg = tasks.reduce((sum, task) => sum + task.confidence, 0) / tasks.length;
  return Number(avg.toFixed(2));
}

function deriveWorkstreamStatus(tasks: ProjectTaskRow[]): WorkstreamStatus {
  if (tasks.some((task) => task.status === "in_progress")) return "in_progress";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "stalled")) return "stalled";
  if (tasks.length > 0 && tasks.every((task) => task.status === "completed")) return "completed";
  return "pending";
}

function deriveLastActivityAt(tasks: ProjectTaskRow[], sessions: ProjectSessionRow[]): string | null {
  const taskTime = tasks
    .map((task) => Date.parse(task.updatedAt))
    .filter((value) => !Number.isNaN(value));
  const sessionTime = sessions
    .map((session) => (session.lastEventAt ? Date.parse(session.lastEventAt) : NaN))
    .filter((value) => !Number.isNaN(value));
  const max = Math.max(0, ...taskTime, ...sessionTime);
  return max > 0 ? new Date(max).toISOString() : null;
}

function countTaskStatuses(tasks: ProjectTaskRow[]): {
  pending: number;
  inProgress: number;
  blocked: number;
  stalled: number;
  completed: number;
} {
  const counts = { pending: 0, inProgress: 0, blocked: 0, stalled: 0, completed: 0 };
  for (const task of tasks) {
    if (task.status === "pending") counts.pending++;
    else if (task.status === "in_progress") counts.inProgress++;
    else if (task.status === "blocked") counts.blocked++;
    else if (task.status === "stalled") counts.stalled++;
    else if (task.status === "completed") counts.completed++;
  }
  return counts;
}

function makeWorkstreamId(projectPath: string): string {
  const digest = createHash("sha1").update(projectPath).digest("hex").slice(0, 16);
  return `workstream_${digest}`;
}

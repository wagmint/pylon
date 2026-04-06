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
  groupingBasis: string;
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

export interface TaskModuleAffinityRow {
  taskId: string;
  moduleKey: string;
  score: number;
  confidence: number;
  isDominant: boolean;
  evidenceJson: string | null;
  derivedAt: string;
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

interface TaskModuleTouchRow {
  taskId: string;
  moduleKey: string;
  action: string;
  filePath: string | null;
}

interface SessionTaskLinkRow {
  sessionId: string;
  taskId: string;
}

interface PlanAnchorRow {
  taskId: string;
  sessionId: string;
  turnIndex: number;
}

interface DerivedTaskModuleAffinity extends TaskModuleAffinityRow {
  id?: number;
}

interface WorkstreamTaskAssignment {
  taskId: string;
  moduleKey: string | null;
  groupingBasis: "dominant_module" | "mixed_module" | "plan_co_occurrence" | "project_fallback";
  confidence: number;
}

interface DerivedWorkstreamCluster {
  canonicalKey: string;
  moduleKey: string | null;
  assignments: WorkstreamTaskAssignment[];
}

export function deriveAndStoreWorkstreamsForProject(projectPath: string): void {
  const db = getDb();
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
    ORDER BY last_event_at DESC, id ASC
  `).all(projectPath) as ProjectSessionRow[];

  if (tasks.length === 0 && sessions.length === 0) {
    cleanupProjectWorkstreams(projectPath);
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
    ORDER BY session_state.last_event_at DESC, session_state.session_id ASC
  `).all(projectPath) as SessionStateRow[];
  const sessionTaskLinks = db.prepare(`
    SELECT
      session_tasks.session_id as sessionId,
      session_tasks.task_id as taskId
    FROM session_tasks
    JOIN tasks ON tasks.id = session_tasks.task_id
    WHERE tasks.project_path = ? AND session_tasks.is_active = 1
  `).all(projectPath) as SessionTaskLinkRow[];
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
  const planAnchors = tasks.length > 0
    ? db.prepare(`
        SELECT DISTINCT
          task_evidence.task_id as taskId,
          plan_items.session_id as sessionId,
          plan_items.turn_index as turnIndex
        FROM task_evidence
        JOIN plan_items
          ON task_evidence.source_table = 'plan_items'
         AND task_evidence.source_row_id = CAST(plan_items.id AS TEXT)
        WHERE task_evidence.task_id IN (${tasks.map(() => "?").join(", ")})
      `).all(...tasks.map((task) => task.id)) as PlanAnchorRow[]
    : [];

  const affinities = replaceTaskModuleAffinities(projectPath, tasks.map((task) => task.id));
  const workstreamClusters = deriveWorkstreamClusters(tasks, affinities, planAnchors);
  const now = new Date().toISOString();
  const sessionStateById = new Map(sessionState.map((row) => [row.sessionId, row]));
  const taskEvidenceByTask = groupBy(taskEvidence, (row) => row.taskId);
  const sessionLinksByTask = groupBy(sessionTaskLinks, (row) => row.taskId);
  const affinitiesByTask = groupBy(affinities, (row) => row.taskId);

  cleanupProjectWorkstreams(projectPath);

  for (const cluster of workstreamClusters) {
    const clusterTasks = cluster.assignments
      .map((assignment) => tasks.find((task) => task.id === assignment.taskId))
      .filter((task): task is ProjectTaskRow => Boolean(task));
    const clusterTaskIds = new Set(clusterTasks.map((task) => task.id));
    const clusterSessions = collectClusterSessions(clusterTaskIds, sessionLinksByTask, sessions);
    const clusterSessionState = clusterSessions
      .map((session) => sessionStateById.get(session.id))
      .filter((row): row is SessionStateRow => Boolean(row));
    const summary = deriveWorkstreamSummary(clusterTasks, clusterSessionState, cluster.moduleKey);
    const confidence = deriveWorkstreamConfidence(clusterTasks, cluster.assignments);
    const status = deriveWorkstreamStatus(clusterTasks);
    const lastActivityAt = deriveLastActivityAt(clusterTasks, clusterSessions);
    const workstreamId = makeWorkstreamId(projectPath, cluster.canonicalKey);
    const title = deriveWorkstreamTitle(projectPath, clusterTasks, cluster.moduleKey, cluster.canonicalKey === "project_fallback");

    db.prepare(`
      INSERT INTO workstreams(
        id, project_path, canonical_key, title, summary, status, confidence, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workstreamId,
      projectPath,
      cluster.canonicalKey,
      title,
      summary,
      status,
      confidence,
      now,
      now,
      JSON.stringify({
        clusterType: cluster.canonicalKey === "project_fallback" ? "project_fallback" : "module",
        moduleKey: cluster.moduleKey,
        projectName: basename(projectPath) || projectPath,
        taskCount: clusterTasks.length,
        sessionCount: clusterSessions.length,
      }),
    );

    for (const assignment of cluster.assignments) {
      db.prepare(`
        INSERT INTO workstream_tasks(workstream_id, task_id, grouping_basis, confidence, derived_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        workstreamId,
        assignment.taskId,
        assignment.groupingBasis,
        assignment.confidence,
        now,
      );
    }

    for (const session of clusterSessions) {
      const relationshipType = sessionStateById.get(session.id)?.status === "completed" ? "supporting" : "active";
      db.prepare(`
        INSERT INTO workstream_sessions(workstream_id, session_id, relationship_type, confidence, derived_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(workstreamId, session.id, relationshipType, 0.9, now);
    }

    insertWorkstreamEvidence({
      workstreamId,
      moduleKey: cluster.moduleKey,
      assignments: cluster.assignments,
      taskEvidenceByTask,
      taskAffinitiesByTask: affinitiesByTask,
      sessionState: clusterSessionState,
      now,
    });

    const counts = countTaskStatuses(clusterTasks);
    db.prepare(`
      INSERT INTO workstream_state(
        workstream_id, derived_at, status, summary, active_task_count, blocked_task_count, stalled_task_count,
        completed_task_count, session_count, confidence, last_activity_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workstreamId,
      now,
      status,
      summary,
      counts.inProgress + counts.pending,
      counts.blocked,
      counts.stalled,
      counts.completed,
      clusterSessions.length,
      confidence,
      lastActivityAt,
    );
  }
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
      grouping_basis as groupingBasis,
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

export function listStoredTaskModuleAffinities(taskId?: string): TaskModuleAffinityRow[] {
  const db = getDb();
  const sql = `
    SELECT
      task_id as taskId,
      module_key as moduleKey,
      score,
      confidence,
      is_dominant as isDominant,
      evidence_json as evidenceJson,
      derived_at as derivedAt
    FROM task_module_affinity
    ${taskId ? "WHERE task_id = ?" : ""}
    ORDER BY confidence DESC, score DESC, module_key ASC
  `;
  return (taskId ? db.prepare(sql).all(taskId) : db.prepare(sql).all()) as TaskModuleAffinityRow[];
}

function replaceTaskModuleAffinities(projectPath: string, taskIds: string[]): DerivedTaskModuleAffinity[] {
  const db = getDb();
  if (taskIds.length === 0) {
    cleanupProjectTaskModuleAffinities(projectPath);
    return [];
  }

  cleanupProjectTaskModuleAffinities(projectPath);

  const rows = db.prepare(`
    SELECT
      session_tasks.task_id as taskId,
      file_touches.module_key as moduleKey,
      file_touches.action as action,
      file_touches.file_path as filePath
    FROM session_tasks
    JOIN tasks ON tasks.id = session_tasks.task_id
    JOIN file_touches ON file_touches.session_id = session_tasks.session_id
    WHERE tasks.project_path = ?
      AND session_tasks.is_active = 1
      AND file_touches.module_key IS NOT NULL
  `).all(projectPath) as TaskModuleTouchRow[];

  const aggregate = new Map<string, Map<string, {
    score: number;
    touchCount: number;
    writeEditCount: number;
    readCount: number;
    searchCount: number;
    samplePaths: Set<string>;
  }>>();

  for (const row of rows) {
    const taskMap = aggregate.get(row.taskId) ?? new Map();
    aggregate.set(row.taskId, taskMap);
    const current = taskMap.get(row.moduleKey) ?? {
      score: 0,
      touchCount: 0,
      writeEditCount: 0,
      readCount: 0,
      searchCount: 0,
      samplePaths: new Set<string>(),
    };
    current.score += weightFileTouch(row.action);
    current.touchCount += 1;
    if (row.action === "write" || row.action === "edit") current.writeEditCount += 1;
    else if (row.action === "read") current.readCount += 1;
    else current.searchCount += 1;
    if (row.filePath && current.samplePaths.size < 3) current.samplePaths.add(row.filePath);
    taskMap.set(row.moduleKey, current);
  }

  const now = new Date().toISOString();
  const derived: DerivedTaskModuleAffinity[] = [];

  for (const taskId of taskIds) {
    const taskAffinities = aggregate.get(taskId);
    if (!taskAffinities || taskAffinities.size === 0) continue;

    const totalScore = [...taskAffinities.values()].reduce((sum, item) => sum + item.score, 0);
    if (totalScore <= 0) continue;

    const sorted = [...taskAffinities.entries()]
      .map(([moduleKey, value]) => ({
        taskId,
        moduleKey,
        score: round2(value.score),
        confidence: round2(value.score / totalScore),
        isDominant: false,
        evidenceJson: JSON.stringify({
          touchCount: value.touchCount,
          writeEditCount: value.writeEditCount,
          readCount: value.readCount,
          searchCount: value.searchCount,
          samplePaths: [...value.samplePaths],
        }),
        derivedAt: now,
      }))
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.moduleKey.localeCompare(b.moduleKey));

    const top = sorted[0];
    const second = sorted[1];
    const hasDominant = Boolean(
      top
      && top.score >= 3
      && top.confidence >= 0.6
      && (!second || top.score - second.score >= 0.5),
    );

    for (const row of sorted) {
      row.isDominant = hasDominant && row.moduleKey === top.moduleKey;
      const inserted = db.prepare(`
        INSERT INTO task_module_affinity(task_id, module_key, score, confidence, is_dominant, evidence_json, derived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.taskId,
        row.moduleKey,
        row.score,
        row.confidence,
        row.isDominant ? 1 : 0,
        row.evidenceJson,
        row.derivedAt,
      ) as { lastInsertRowid?: number | bigint };
      derived.push({
        ...row,
        id: inserted.lastInsertRowid !== undefined ? Number(inserted.lastInsertRowid) : undefined,
      });
    }
  }

  return derived;
}

function deriveWorkstreamClusters(
  tasks: ProjectTaskRow[],
  affinities: DerivedTaskModuleAffinity[],
  planAnchors: PlanAnchorRow[],
): DerivedWorkstreamCluster[] {
  if (tasks.length === 0) return [];
  if (tasks.length === 1) {
    return [buildFallbackCluster(tasks)];
  }

  const affinitiesByTask = groupBy(affinities, (row) => row.taskId);
  const assignments = new Map<string, WorkstreamTaskAssignment>();
  const anchorToTaskIds = new Map<string, Set<string>>();
  const anchorsByTask = new Map<string, string[]>();

  for (const anchor of planAnchors) {
    const key = `${anchor.sessionId}:${anchor.turnIndex}`;
    const taskIds = anchorToTaskIds.get(key) ?? new Set<string>();
    taskIds.add(anchor.taskId);
    anchorToTaskIds.set(key, taskIds);
    const taskAnchors = anchorsByTask.get(anchor.taskId) ?? [];
    taskAnchors.push(key);
    anchorsByTask.set(anchor.taskId, taskAnchors);
  }

  for (const task of tasks) {
    const top = affinitiesByTask.get(task.id)?.[0];
    if (top?.isDominant) {
      assignments.set(task.id, {
        taskId: task.id,
        moduleKey: top.moduleKey,
        groupingBasis: "dominant_module",
        confidence: top.confidence,
      });
    }
  }

  const dominantGroups = groupAssignmentsByModule(assignments);
  if (dominantGroups.size < 2) {
    return [buildFallbackCluster(tasks)];
  }

  for (const task of tasks) {
    if (assignments.has(task.id)) continue;
    const top = affinitiesByTask.get(task.id)?.[0];
    if (top && dominantGroups.has(top.moduleKey) && top.confidence >= 0.45) {
      assignments.set(task.id, {
        taskId: task.id,
        moduleKey: top.moduleKey,
        groupingBasis: "mixed_module",
        confidence: top.confidence,
      });
    }
  }

  for (const task of tasks) {
    if (assignments.has(task.id)) continue;
    const matchedModule = resolvePlanCoOccurrenceModule(task.id, anchorsByTask, anchorToTaskIds, assignments);
    if (matchedModule) {
      assignments.set(task.id, {
        taskId: task.id,
        moduleKey: matchedModule,
        groupingBasis: "plan_co_occurrence",
        confidence: 0.62,
      });
    }
  }

  const assignmentCoverage = assignments.size / tasks.length;
  if (assignmentCoverage < 0.75) {
    return [buildFallbackCluster(tasks)];
  }

  const grouped = groupAssignmentsByModule(assignments);
  if (grouped.size < 2) {
    return [buildFallbackCluster(tasks)];
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([moduleKey, moduleAssignments]) => ({
      canonicalKey: `module:${moduleKey}`,
      moduleKey,
      assignments: moduleAssignments.sort((a, b) => b.confidence - a.confidence || a.taskId.localeCompare(b.taskId)),
    }));
}

function buildFallbackCluster(tasks: ProjectTaskRow[]): DerivedWorkstreamCluster {
  return {
    canonicalKey: "project_fallback",
    moduleKey: null,
    assignments: tasks.map((task) => ({
      taskId: task.id,
      moduleKey: null,
      groupingBasis: "project_fallback" as const,
      confidence: task.confidence,
    })),
  };
}

function resolvePlanCoOccurrenceModule(
  taskId: string,
  anchorsByTask: Map<string, string[]>,
  anchorToTaskIds: Map<string, Set<string>>,
  assignments: Map<string, WorkstreamTaskAssignment>,
): string | null {
  const anchors = anchorsByTask.get(taskId) ?? [];
  const modules = new Set<string>();
  for (const anchor of anchors) {
    for (const linkedTaskId of anchorToTaskIds.get(anchor) ?? []) {
      if (linkedTaskId === taskId) continue;
      const linkedAssignment = assignments.get(linkedTaskId);
      if (linkedAssignment?.moduleKey) {
        modules.add(linkedAssignment.moduleKey);
      }
    }
  }
  if (modules.size !== 1) return null;
  return [...modules][0] ?? null;
}

function insertWorkstreamEvidence(input: {
  workstreamId: string;
  moduleKey: string | null;
  assignments: WorkstreamTaskAssignment[];
  taskEvidenceByTask: Map<string, TaskEvidenceSnippetRow[]>;
  taskAffinitiesByTask: Map<string, DerivedTaskModuleAffinity[]>;
  sessionState: SessionStateRow[];
  now: string;
}): void {
  const db = getDb();

  if (input.moduleKey) {
    const insertedTaskIds = new Set<string>();
    for (const assignment of input.assignments) {
      if (insertedTaskIds.has(assignment.taskId)) continue;
      insertedTaskIds.add(assignment.taskId);
      const affinity = (input.taskAffinitiesByTask.get(assignment.taskId) ?? []).find((row) => row.moduleKey === input.moduleKey);
      if (!affinity) continue;
      const evidence = parseEvidenceJson(affinity.evidenceJson);
      const snippet = evidence.samplePaths?.length
        ? `${input.moduleKey}: ${evidence.samplePaths.join(", ")}`
        : input.moduleKey;
      db.prepare(`
        INSERT INTO workstream_evidence(workstream_id, evidence_type, source_table, source_row_id, snippet, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.workstreamId,
        "module_affinity",
        "task_module_affinity",
        affinity.id ? String(affinity.id) : null,
        snippet,
        affinity.confidence,
        input.now,
      );
    }
  }

  const insertedTaskEvidence = new Set<string>();
  for (const assignment of input.assignments) {
    for (const evidence of input.taskEvidenceByTask.get(assignment.taskId) ?? []) {
      const key = `${evidence.taskId}:${evidence.evidenceType}:${evidence.snippet ?? ""}`;
      if (insertedTaskEvidence.has(key)) continue;
      insertedTaskEvidence.add(key);
      db.prepare(`
        INSERT INTO workstream_evidence(workstream_id, evidence_type, source_table, source_row_id, snippet, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.workstreamId,
        evidence.evidenceType,
        evidence.sourceTable,
        evidence.sourceRowId,
        evidence.snippet,
        evidence.confidence,
        input.now,
      );
      if (insertedTaskEvidence.size >= 6) break;
    }
    if (insertedTaskEvidence.size >= 6) break;
  }

  for (const session of input.sessionState.slice(0, 3)) {
    db.prepare(`
      INSERT INTO workstream_evidence(workstream_id, evidence_type, source_table, source_row_id, snippet, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.workstreamId,
      "session_goal",
      "session_state",
      session.sessionId,
      session.currentGoal,
      0.64,
      input.now,
    );
  }
}

function collectClusterSessions(
  taskIds: Set<string>,
  sessionLinksByTask: Map<string, SessionTaskLinkRow[]>,
  allProjectSessions: ProjectSessionRow[],
): ProjectSessionRow[] {
  if (taskIds.size === 0) return allProjectSessions;
  const sessionIds = new Set<string>();
  for (const taskId of taskIds) {
    for (const row of sessionLinksByTask.get(taskId) ?? []) {
      sessionIds.add(row.sessionId);
    }
  }
  return allProjectSessions.filter((session) => sessionIds.has(session.id));
}

function cleanupProjectWorkstreams(projectPath: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM workstreams WHERE project_path = ?`).run(projectPath);
}

function cleanupProjectTaskModuleAffinities(projectPath: string): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM task_module_affinity
    WHERE task_id IN (SELECT id FROM tasks WHERE project_path = ?)
  `).run(projectPath);
}

function deriveWorkstreamTitle(
  projectPath: string,
  tasks: ProjectTaskRow[],
  moduleKey: string | null,
  isFallback: boolean,
): string {
  const projectName = basename(projectPath) || projectPath;
  if (!isFallback && moduleKey) return `${projectName}: ${moduleKey}`;
  if (tasks.length === 0) return projectName;
  const top = tasks.slice(0, 2).map((task) => task.title);
  if (top.length === 1) return `${projectName}: ${top[0]}`;
  return `${projectName}: ${top[0]} + ${tasks.length - 1} more`;
}

function deriveWorkstreamSummary(
  tasks: ProjectTaskRow[],
  sessionState: SessionStateRow[],
  moduleKey: string | null,
): string {
  const prefix = moduleKey ? `Module: ${moduleKey}. ` : "";
  const taskPart = tasks.length > 0
    ? `Tasks: ${tasks.slice(0, 3).map((task) => task.title).join("; ")}`
    : "No derived tasks";
  const goalPart = sessionState.length > 0
    ? `Current goals: ${sessionState.slice(0, 2).map((row) => row.currentGoal).join("; ")}`
    : "No active session goals";
  return `${prefix}${taskPart}. ${goalPart}`;
}

function deriveWorkstreamConfidence(
  tasks: ProjectTaskRow[],
  assignments: WorkstreamTaskAssignment[],
): number {
  if (tasks.length === 0) return 0.45;
  const taskAverage = tasks.reduce((sum, task) => sum + task.confidence, 0) / tasks.length;
  const assignmentAverage = assignments.reduce((sum, assignment) => sum + assignment.confidence, 0) / assignments.length;
  return round2((taskAverage + assignmentAverage) / 2);
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

function groupAssignmentsByModule(assignments: Map<string, WorkstreamTaskAssignment>): Map<string, WorkstreamTaskAssignment[]> {
  const grouped = new Map<string, WorkstreamTaskAssignment[]>();
  for (const assignment of assignments.values()) {
    if (!assignment.moduleKey) continue;
    const list = grouped.get(assignment.moduleKey) ?? [];
    list.push(assignment);
    grouped.set(assignment.moduleKey, list);
  }
  return grouped;
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return grouped;
}

function weightFileTouch(action: string): number {
  if (action === "write" || action === "edit") return 3;
  if (action === "read") return 1;
  if (action === "search") return 0.5;
  return 0;
}

function parseEvidenceJson(value: string | null): { samplePaths?: string[] } {
  if (!value) return {};
  try {
    return JSON.parse(value) as { samplePaths?: string[] };
  } catch {
    return {};
  }
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function makeWorkstreamId(projectPath: string, canonicalKey: string): string {
  const digest = createHash("sha1").update(`${projectPath}\0${canonicalKey}`).digest("hex").slice(0, 16);
  return `workstream_${digest}`;
}

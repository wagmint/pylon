import { createHash } from "node:crypto";
import { getDb } from "./db.js";

export type TaskStatus = "pending" | "in_progress" | "blocked" | "stalled" | "completed";
export type TaskType = "explicit" | "inferred";

export interface TaskRow {
  id: string;
  projectPath: string;
  canonicalKey: string;
  title: string;
  description: string | null;
  taskType: TaskType;
  status: TaskStatus;
  confidence: number;
  sourceSessionId: string;
  createdAt: string;
  updatedAt: string;
  metadataJson: string | null;
}

export interface SessionTaskRow {
  sessionId: string;
  taskId: string;
  relationshipType: string;
  confidence: number;
  derivedAt: string;
  isActive: boolean;
}

export interface TaskEvidenceRow {
  taskId: string;
  sessionId: string;
  evidenceType: string;
  sourceTable: string;
  sourceRowId: string | null;
  snippet: string | null;
  confidence: number;
  createdAt: string;
}

interface SessionInfoRow {
  id: string;
  projectPath: string;
}

interface SessionStateInfoRow {
  status: string;
  currentGoal: string;
  lastMeaningfulAction: string;
  filesInPlayJson: string;
}

interface PlanItemCandidateRow {
  id: number;
  turnIndex: number;
  source: string;
  taskId: string | null;
  subject: string;
  description: string | null;
  status: string | null;
  rawText: string | null;
}

interface CommandEvidenceRow {
  id: number;
  commandText: string;
}

interface Candidate {
  canonicalKey: string;
  title: string;
  description: string | null;
  taskType: TaskType;
  confidence: number;
  relationshipType: "primary" | "supporting";
  evidence: Array<{
    evidenceType: string;
    sourceTable: string;
    sourceRowId: string | null;
    snippet: string | null;
    confidence: number;
  }>;
}

export function deriveAndStoreTasksForSession(sessionId: string): void {
  const db = getDb();
  const session = db.prepare(`
    SELECT
      id,
      project_path as projectPath
    FROM sessions
    WHERE id = ?
  `).get(sessionId) as SessionInfoRow | undefined;
  if (!session) return;

  const sessionState = db.prepare(`
    SELECT
      status,
      current_goal as currentGoal,
      last_meaningful_action as lastMeaningfulAction,
      files_in_play_json as filesInPlayJson
    FROM session_state
    WHERE session_id = ?
  `).get(sessionId) as SessionStateInfoRow | undefined;
  if (!sessionState) return;

  const planItems = db.prepare(`
    SELECT
      id,
      turn_index as turnIndex,
      source,
      task_id as taskId,
      subject,
      description,
      status,
      raw_text as rawText
    FROM plan_items
    WHERE session_id = ?
    ORDER BY turn_index DESC, id DESC
  `).all(sessionId) as PlanItemCandidateRow[];

  const commands = db.prepare(`
    SELECT
      id,
      command_text as commandText
    FROM commands
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT 3
  `).all(sessionId) as CommandEvidenceRow[];

  const filesInPlay = safeParseJsonArray(sessionState.filesInPlayJson);
  const candidates = deriveTaskCandidates({
    sessionId,
    projectPath: session.projectPath,
    sessionState,
    planItems,
    filesInPlay,
    commands,
  });

  db.prepare(`DELETE FROM task_evidence WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM session_tasks WHERE session_id = ?`).run(sessionId);

  const touchedTaskIds = new Set<string>();
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    const taskId = upsertTask({
      projectPath: session.projectPath,
      canonicalKey: candidate.canonicalKey,
      title: candidate.title,
      description: candidate.description,
      taskType: candidate.taskType,
      confidence: candidate.confidence,
      sourceSessionId: sessionId,
      now,
    });
    touchedTaskIds.add(taskId);

    db.prepare(`
      INSERT INTO session_tasks(session_id, task_id, relationship_type, confidence, derived_at, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(session_id, task_id) DO UPDATE SET
        relationship_type = excluded.relationship_type,
        confidence = excluded.confidence,
        derived_at = excluded.derived_at,
        is_active = 1
    `).run(
      sessionId,
      taskId,
      candidate.relationshipType,
      candidate.confidence,
      now,
    );

    for (const evidence of candidate.evidence) {
      db.prepare(`
        INSERT INTO task_evidence(task_id, session_id, evidence_type, source_table, source_row_id, snippet, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        sessionId,
        evidence.evidenceType,
        evidence.sourceTable,
        evidence.sourceRowId,
        evidence.snippet,
        evidence.confidence,
        now,
      );
    }
  }

  for (const taskId of touchedTaskIds) {
    refreshTaskAggregate(taskId);
  }
  cleanupOrphanTasks();
}

export function listStoredTasks(projectPath?: string): TaskRow[] {
  const db = getDb();
  const sql = `
    SELECT
      id,
      project_path as projectPath,
      canonical_key as canonicalKey,
      title,
      description,
      task_type as taskType,
      status,
      confidence,
      source_session_id as sourceSessionId,
      created_at as createdAt,
      updated_at as updatedAt,
      metadata_json as metadataJson
    FROM tasks
    ${projectPath ? "WHERE project_path = ?" : ""}
    ORDER BY updated_at DESC, title ASC
  `;
  return (projectPath ? db.prepare(sql).all(projectPath) : db.prepare(sql).all()) as TaskRow[];
}

export function listStoredSessionTasks(sessionId?: string): SessionTaskRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      task_id as taskId,
      relationship_type as relationshipType,
      confidence,
      derived_at as derivedAt,
      is_active as isActive
    FROM session_tasks
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY derived_at DESC, task_id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as SessionTaskRow[];
}

export function listStoredTaskEvidence(taskId?: string): TaskEvidenceRow[] {
  const db = getDb();
  const sql = `
    SELECT
      task_id as taskId,
      session_id as sessionId,
      evidence_type as evidenceType,
      source_table as sourceTable,
      source_row_id as sourceRowId,
      snippet,
      confidence,
      created_at as createdAt
    FROM task_evidence
    ${taskId ? "WHERE task_id = ?" : ""}
    ORDER BY created_at DESC, id DESC
  `;
  return (taskId ? db.prepare(sql).all(taskId) : db.prepare(sql).all()) as TaskEvidenceRow[];
}

function deriveTaskCandidates(input: {
  sessionId: string;
  projectPath: string;
  sessionState: SessionStateInfoRow;
  planItems: PlanItemCandidateRow[];
  filesInPlay: string[];
  commands: CommandEvidenceRow[];
}): Candidate[] {
  const candidates = new Map<string, Candidate>();

  for (const item of input.planItems) {
    if (!isMeaningfulTaskTitle(item.subject)) continue;
    const canonicalKey = canonicalizeTaskKey(item.subject);
    if (!candidates.has(canonicalKey)) {
      candidates.set(canonicalKey, {
        canonicalKey,
        title: item.subject.trim(),
        description: item.description ?? null,
        taskType: "explicit",
        confidence: 0.98,
        relationshipType: item.status === "completed" || item.status === "done" ? "supporting" : "primary",
        evidence: [],
      });
    }
    candidates.get(canonicalKey)!.evidence.push({
      evidenceType: item.source,
      sourceTable: "plan_items",
      sourceRowId: String(item.id),
      snippet: item.rawText ?? item.subject,
      confidence: 0.98,
    });
  }

  const currentGoal = input.sessionState.currentGoal.trim();
  const inferredGoalKey = canonicalizeTaskKey(currentGoal);
  const shouldInferGoalTask = isMeaningfulTaskTitle(currentGoal) && !candidates.has(inferredGoalKey);
  if (shouldInferGoalTask) {
    const candidate: Candidate = {
      canonicalKey: inferredGoalKey,
      title: currentGoal,
      description: null,
      taskType: "inferred",
      confidence: 0.76,
      relationshipType: "primary",
      evidence: [
        {
          evidenceType: "session_goal",
          sourceTable: "session_state",
          sourceRowId: input.sessionId,
          snippet: currentGoal,
          confidence: 0.76,
        },
      ],
    };

    const cluster = describeFileCluster(input.filesInPlay);
    if (cluster) {
      candidate.evidence.push({
        evidenceType: "file_cluster",
        sourceTable: "session_state",
        sourceRowId: input.sessionId,
        snippet: cluster,
        confidence: 0.58,
      });
    }

    if (input.commands[0]) {
      candidate.evidence.push({
        evidenceType: "action_pattern",
        sourceTable: "commands",
        sourceRowId: String(input.commands[0].id),
        snippet: input.commands[0].commandText,
        confidence: 0.48,
      });
    }

    candidates.set(inferredGoalKey, candidate);
  } else if (candidates.has(inferredGoalKey)) {
    const candidate = candidates.get(inferredGoalKey)!;
    candidate.evidence.push({
      evidenceType: "session_goal",
      sourceTable: "session_state",
      sourceRowId: input.sessionId,
      snippet: currentGoal,
      confidence: 0.72,
    });
    const cluster = describeFileCluster(input.filesInPlay);
    if (cluster) {
      candidate.evidence.push({
        evidenceType: "file_cluster",
        sourceTable: "session_state",
        sourceRowId: input.sessionId,
        snippet: cluster,
        confidence: 0.56,
      });
    }
  }

  if (candidates.size === 0 && input.filesInPlay.length > 0) {
    const cluster = describeFileCluster(input.filesInPlay);
    const title = cluster ? `Work on ${cluster}` : "Inferred session work";
    const canonicalKey = canonicalizeTaskKey(title);
    candidates.set(canonicalKey, {
      canonicalKey,
      title,
      description: null,
      taskType: "inferred",
      confidence: 0.55,
      relationshipType: "primary",
      evidence: [
        {
          evidenceType: "file_cluster",
          sourceTable: "session_state",
          sourceRowId: input.sessionId,
          snippet: cluster,
          confidence: 0.55,
        },
      ],
    });
  }

  return [...candidates.values()];
}

function upsertTask(input: {
  projectPath: string;
  canonicalKey: string;
  title: string;
  description: string | null;
  taskType: TaskType;
  confidence: number;
  sourceSessionId: string;
  now: string;
}): string {
  const db = getDb();
  const taskId = makeTaskId(input.projectPath, input.canonicalKey);
  db.prepare(`
    INSERT INTO tasks(
      id, project_path, canonical_key, title, description, task_type, status,
      confidence, source_session_id, created_at, updated_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    ON CONFLICT(project_path, canonical_key) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      task_type = excluded.task_type,
      confidence = CASE
        WHEN excluded.confidence > tasks.confidence THEN excluded.confidence
        ELSE tasks.confidence
      END,
      updated_at = excluded.updated_at,
      metadata_json = excluded.metadata_json
  `).run(
    taskId,
    input.projectPath,
    input.canonicalKey,
    input.title,
    input.description,
    input.taskType,
    input.confidence,
    input.sourceSessionId,
    input.now,
    input.now,
    JSON.stringify({ sourceSessionId: input.sourceSessionId }),
  );
  return taskId;
}

function refreshTaskAggregate(taskId: string): void {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      MAX(session_tasks.confidence) as maxConfidence,
      SUM(CASE WHEN session_state.status = 'blocked' THEN 1 ELSE 0 END) as blockedCount,
      SUM(CASE WHEN session_state.status = 'stalled' THEN 1 ELSE 0 END) as stalledCount,
      SUM(CASE WHEN session_state.status = 'completed' THEN 1 ELSE 0 END) as completedCount,
      SUM(CASE WHEN session_state.status = 'in_progress' THEN 1 ELSE 0 END) as inProgressCount,
      COUNT(*) as totalCount
    FROM session_tasks
    JOIN session_state ON session_state.session_id = session_tasks.session_id
    WHERE session_tasks.task_id = ? AND session_tasks.is_active = 1
  `).get(taskId) as {
    maxConfidence?: number;
    blockedCount?: number;
    stalledCount?: number;
    completedCount?: number;
    inProgressCount?: number;
    totalCount?: number;
  } | undefined;
  if (!row || !row.totalCount) return;

  const status = deriveAggregatedTaskStatus({
    blockedCount: row.blockedCount ?? 0,
    stalledCount: row.stalledCount ?? 0,
    completedCount: row.completedCount ?? 0,
    inProgressCount: row.inProgressCount ?? 0,
    totalCount: row.totalCount ?? 0,
  });

  db.prepare(`
    UPDATE tasks
    SET
      status = ?,
      confidence = COALESCE(?, confidence),
      updated_at = ?
    WHERE id = ?
  `).run(status, row.maxConfidence ?? null, new Date().toISOString(), taskId);
}

function cleanupOrphanTasks(): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM tasks
    WHERE id IN (
      SELECT tasks.id
      FROM tasks
      LEFT JOIN session_tasks ON session_tasks.task_id = tasks.id AND session_tasks.is_active = 1
      WHERE session_tasks.id IS NULL
    )
  `).run();
}

function deriveAggregatedTaskStatus(input: {
  blockedCount: number;
  stalledCount: number;
  completedCount: number;
  inProgressCount: number;
  totalCount: number;
}): TaskStatus {
  if (input.inProgressCount > 0) return "in_progress";
  if (input.blockedCount > 0) return "blocked";
  if (input.stalledCount > 0) return "stalled";
  if (input.completedCount > 0 && input.completedCount === input.totalCount) return "completed";
  return "pending";
}

function makeTaskId(projectPath: string, canonicalKey: string): string {
  const digest = createHash("sha1").update(`${projectPath}\0${canonicalKey}`).digest("hex").slice(0, 16);
  return `task_${digest}`;
}

function canonicalizeTaskKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120);
}

function isMeaningfulTaskTitle(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || normalized.length < 4) return false;

  const lowInfo = new Set([
    "continue",
    "keep going",
    "try again",
    "work on it",
    "do it",
    "fix it",
    "help",
    "plan",
    "yes",
    "okay",
    "sure",
    "thanks",
    "please",
    "go ahead",
    "sounds good",
    "looks good",
    "lgtm",
    "do that",
    "yes please",
    "please do",
    "go for it",
    "ship it",
    "run it",
    "try it",
    "test it",
  ]);
  if (lowInfo.has(normalized)) return false;

  // Prefix-based filtering for short vague messages (under 40 chars).
  if (normalized.length < 40) {
    const lowInfoPrefixes = [
      "continue",
      "keep going",
      "keep working",
      "try again",
      "do it",
      "just do",
      "just fix",
      "go ahead",
    ];
    if (lowInfoPrefixes.some((prefix) => normalized.startsWith(prefix))) return false;
  }

  return true;
}

function describeFileCluster(files: string[]): string | null {
  if (files.length === 0) return null;

  const dirs = files
    .map((f) => {
      const parts = f.split("/").filter(Boolean);
      return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
    })
    .filter((d): d is string => d !== null);

  if (dirs.length === 0) {
    // All files are root-level (no directory component). Use first filename.
    return files[0].split("/").filter(Boolean).pop() ?? files[0];
  }

  // Compute deepest common directory prefix.
  const splitDirs = dirs.map((d) => d.split("/"));
  const commonParts: string[] = [];
  for (let i = 0; i < splitDirs[0].length; i++) {
    const segment = splitDirs[0][i];
    if (splitDirs.every((parts) => parts[i] === segment)) {
      commonParts.push(segment);
    } else {
      break;
    }
  }

  // If common prefix has depth >= 2, it's specific enough.
  if (commonParts.length >= 2) {
    return commonParts.join("/");
  }

  // Otherwise list distinct directories sorted alphabetically, top 3.
  const unique = [...new Set(dirs)].sort();
  return unique.slice(0, 3).join(", ");
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

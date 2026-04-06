import { createHash } from "node:crypto";
import { getDb } from "./db.js";

export interface HandoffRow {
  id: string;
  sessionId: string;
  projectPath: string;
  handoffType: string;
  title: string;
  summary: string;
  status: string;
  openQuestionsJson: string;
  nextStepsJson: string;
  filesInPlayJson: string;
  resumePackageJson: string;
  lastEventAt: string | null;
  derivedAt: string;
  createdAt: string;
  updatedAt: string;
  metadataJson: string | null;
}

export interface HandoffAttachmentRow {
  ownerId: string;
  handoffId: string;
  relationshipType: string;
  confidence: number;
  derivedAt: string;
}

interface SessionHandoffRow {
  sessionId: string;
  projectPath: string;
  endedAt: string | null;
  status: string;
  currentGoal: string;
  lastMeaningfulAction: string;
  resumeSummary: string;
  blockedReason: string | null;
  pendingApprovalCount: number;
  filesInPlayJson: string;
  lastEventAt: string | null;
}

interface SessionCompactionRow {
  sessionId: string;
  turnIndex: number;
  compactionText: string | null;
  startedAt: string;
}

interface SessionTaskRow {
  sessionId: string;
  taskId: string;
}

interface SessionWorkstreamRow {
  sessionId: string;
  workstreamId: string;
}

interface SessionArtifactRow {
  sessionId: string;
  artifactId: string;
}

export function deriveAndStoreHandoffsForProject(projectPath: string): void {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT
      sessions.id as sessionId,
      sessions.project_path as projectPath,
      sessions.ended_at as endedAt,
      session_state.status as status,
      session_state.current_goal as currentGoal,
      session_state.last_meaningful_action as lastMeaningfulAction,
      session_state.resume_summary as resumeSummary,
      session_state.blocked_reason as blockedReason,
      session_state.pending_approval_count as pendingApprovalCount,
      session_state.files_in_play_json as filesInPlayJson,
      session_state.last_event_at as lastEventAt
    FROM session_state
    JOIN sessions ON sessions.id = session_state.session_id
    WHERE sessions.project_path = ?
  `).all(projectPath) as SessionHandoffRow[];

  if (sessions.length === 0) {
    cleanupProjectHandoffs(projectPath);
    return;
  }

  cleanupProjectHandoffs(projectPath);

  const sessionIds = sessions.map((session) => session.sessionId);
  const taskIdsBySession = groupMultiMap(
    db.prepare(`
      SELECT session_id as sessionId, task_id as taskId
      FROM session_tasks
      WHERE is_active = 1
        AND session_id IN (${sessionIds.map(() => "?").join(", ")})
    `).all(...sessionIds) as SessionTaskRow[],
    (row) => row.sessionId,
    (row) => row.taskId,
  );
  const workstreamIdsBySession = groupMultiMap(
    db.prepare(`
      SELECT workstream_sessions.session_id as sessionId, workstream_sessions.workstream_id as workstreamId
      FROM workstream_sessions
      JOIN workstreams ON workstreams.id = workstream_sessions.workstream_id
      WHERE workstreams.project_path = ?
    `).all(projectPath) as SessionWorkstreamRow[],
    (row) => row.sessionId,
    (row) => row.workstreamId,
  );
  const artifactIdsBySession = groupMultiMap(
    db.prepare(`
      SELECT session_id as sessionId, artifact_id as artifactId
      FROM session_artifacts
      WHERE session_id IN (${sessionIds.map(() => "?").join(", ")})
    `).all(...sessionIds) as SessionArtifactRow[],
    (row) => row.sessionId,
    (row) => row.artifactId,
  );
  const latestCompactions = new Map(
    (
      db.prepare(`
        SELECT
          session_id as sessionId,
          turn_index as turnIndex,
          compaction_text as compactionText,
          started_at as startedAt
        FROM turns
        WHERE session_id IN (${sessionIds.map(() => "?").join(", ")})
          AND has_compaction = 1
        ORDER BY started_at ASC, turn_index ASC
      `).all(...sessionIds) as SessionCompactionRow[]
    ).map((row) => [row.sessionId, row]),
  );

  const now = new Date().toISOString();

  for (const session of sessions) {
    const trigger = deriveHandoffTrigger(session, latestCompactions.get(session.sessionId));
    if (!trigger) continue;

    const filesInPlay = safeParseJsonArray(session.filesInPlayJson);
    const openQuestions = deriveOpenQuestions(session, trigger);
    const nextSteps = deriveNextSteps(session, trigger, filesInPlay);
    const resumePackage = {
      sessionId: session.sessionId,
      handoffType: trigger.type,
      goal: session.currentGoal,
      lastMeaningfulAction: session.lastMeaningfulAction,
      blockedReason: session.blockedReason,
      openQuestions,
      nextSteps,
      filesInPlay,
      compactionText: trigger.compactionText ?? null,
    };
    const handoffId = makeHandoffId(session.sessionId, trigger.type);
    const summary = buildHandoffSummary(session, trigger, openQuestions, nextSteps);

    db.prepare(`
      INSERT INTO handoffs(
        id, session_id, project_path, handoff_type, title, summary, status,
        open_questions_json, next_steps_json, files_in_play_json, resume_package_json,
        last_event_at, derived_at, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoffId,
      session.sessionId,
      projectPath,
      trigger.type,
      `${capitalize(trigger.type)} handoff: ${truncate(session.currentGoal, 120)}`,
      summary,
      "open",
      JSON.stringify(openQuestions),
      JSON.stringify(nextSteps),
      JSON.stringify(filesInPlay),
      JSON.stringify(resumePackage),
      session.lastEventAt,
      now,
      now,
      now,
      JSON.stringify({
        triggerType: trigger.type,
        compactionText: trigger.compactionText ?? null,
      }),
    );

    attachHandoffRows("handoff_tasks", "task_id", handoffId, [...(taskIdsBySession.get(session.sessionId) ?? new Set<string>())], "continues", 0.9, now);
    attachHandoffRows("handoff_workstreams", "workstream_id", handoffId, [...(workstreamIdsBySession.get(session.sessionId) ?? new Set<string>())], "belongs_to", 0.86, now);
    attachHandoffRows("handoff_artifacts", "artifact_id", handoffId, [...(artifactIdsBySession.get(session.sessionId) ?? new Set<string>())], "resume_with", 0.82, now);
  }
}

export function listStoredHandoffs(projectPath?: string): HandoffRow[] {
  const db = getDb();
  const sql = `
    SELECT
      id,
      session_id as sessionId,
      project_path as projectPath,
      handoff_type as handoffType,
      title,
      summary,
      status,
      open_questions_json as openQuestionsJson,
      next_steps_json as nextStepsJson,
      files_in_play_json as filesInPlayJson,
      resume_package_json as resumePackageJson,
      last_event_at as lastEventAt,
      derived_at as derivedAt,
      created_at as createdAt,
      updated_at as updatedAt,
      metadata_json as metadataJson
    FROM handoffs
    ${projectPath ? "WHERE project_path = ?" : ""}
    ORDER BY last_event_at DESC, session_id ASC
  `;
  return (projectPath ? db.prepare(sql).all(projectPath) : db.prepare(sql).all()) as HandoffRow[];
}

export function listStoredHandoffTasks(handoffId?: string): HandoffAttachmentRow[] {
  return listAttachmentRows("handoff_tasks", "task_id", handoffId);
}

export function listStoredHandoffWorkstreams(handoffId?: string): HandoffAttachmentRow[] {
  return listAttachmentRows("handoff_workstreams", "workstream_id", handoffId);
}

export function listStoredHandoffArtifacts(handoffId?: string): HandoffAttachmentRow[] {
  return listAttachmentRows("handoff_artifacts", "artifact_id", handoffId);
}

function deriveHandoffTrigger(
  session: SessionHandoffRow,
  latestCompaction: SessionCompactionRow | undefined,
): { type: string; compactionText: string | null } | null {
  if (session.status === "blocked") {
    return { type: "blocked", compactionText: latestCompaction?.compactionText ?? null };
  }
  if (session.status === "stalled") {
    return { type: "stalled", compactionText: latestCompaction?.compactionText ?? null };
  }
  if (latestCompaction) {
    return { type: "compacted", compactionText: latestCompaction.compactionText ?? null };
  }
  if (session.endedAt) {
    return { type: "ended", compactionText: null };
  }
  if (session.status === "idle") {
    return { type: "idle", compactionText: null };
  }
  return null;
}

function deriveOpenQuestions(
  session: SessionHandoffRow,
  trigger: { type: string; compactionText: string | null },
): string[] {
  const questions: string[] = [];
  if (session.blockedReason) {
    questions.push(session.blockedReason);
  } else if (trigger.type === "compacted" && trigger.compactionText) {
    questions.push(`Restore context after compaction: ${trigger.compactionText}`);
  } else if (trigger.type === "idle" || trigger.type === "ended") {
    questions.push(`Should work continue on: ${session.currentGoal}?`);
  }
  return questions.slice(0, 3);
}

function deriveNextSteps(
  session: SessionHandoffRow,
  trigger: { type: string; compactionText: string | null },
  filesInPlay: string[],
): string[] {
  const steps: string[] = [];
  if (trigger.type === "blocked" && session.blockedReason) {
    steps.push(`Resolve blocker: ${session.blockedReason}`);
  } else if (trigger.type === "stalled" && session.blockedReason) {
    steps.push(`Address error: ${session.blockedReason}`);
  } else if (trigger.type === "compacted") {
    steps.push(`Rehydrate context and continue: ${session.currentGoal}`);
  } else {
    steps.push(`Resume: ${session.currentGoal}`);
  }
  if (filesInPlay.length > 0) {
    steps.push(`Reopen files: ${filesInPlay.slice(0, 3).join(", ")}`);
  }
  if (session.lastMeaningfulAction !== "No recent action") {
    steps.push(session.lastMeaningfulAction);
  }
  return dedupeStrings(steps).slice(0, 4);
}

function buildHandoffSummary(
  session: SessionHandoffRow,
  trigger: { type: string; compactionText: string | null },
  openQuestions: string[],
  nextSteps: string[],
): string {
  const parts = [session.resumeSummary];
  if (trigger.type === "compacted" && trigger.compactionText) {
    parts.push(`Compaction: ${trigger.compactionText}`);
  }
  if (openQuestions.length > 0) {
    parts.push(`Open questions: ${openQuestions.join("; ")}`);
  }
  if (nextSteps.length > 0) {
    parts.push(`Next steps: ${nextSteps.join("; ")}`);
  }
  return parts.join(". ");
}

function attachHandoffRows(
  table: string,
  valueColumn: string,
  handoffId: string,
  values: string[],
  relationshipType: string,
  confidence: number,
  now: string,
): void {
  const db = getDb();
  for (const value of values) {
    db.prepare(`
      INSERT INTO ${table}(handoff_id, ${valueColumn}, relationship_type, confidence, derived_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(handoffId, value, relationshipType, confidence, now);
  }
}

function cleanupProjectHandoffs(projectPath: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM handoffs WHERE project_path = ?`).run(projectPath);
}

function listAttachmentRows(table: string, valueColumn: string, handoffId?: string): HandoffAttachmentRow[] {
  const db = getDb();
  const sql = `
    SELECT
      ${valueColumn} as ownerId,
      handoff_id as handoffId,
      relationship_type as relationshipType,
      confidence,
      derived_at as derivedAt
    FROM ${table}
    ${handoffId ? "WHERE handoff_id = ?" : ""}
    ORDER BY derived_at DESC, ${valueColumn} ASC
  `;
  return (handoffId ? db.prepare(sql).all(handoffId) : db.prepare(sql).all()) as HandoffAttachmentRow[];
}

function groupMultiMap<T>(rows: T[], keyFn: (row: T) => string, valueFn: (row: T) => string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = keyFn(row);
    const set = result.get(key) ?? new Set<string>();
    set.add(valueFn(row));
    result.set(key, set);
  }
  return result;
}

function makeHandoffId(sessionId: string, handoffType: string): string {
  const digest = createHash("sha1").update(`${sessionId}\0${handoffType}`).digest("hex").slice(0, 16);
  return `handoff_${digest}`;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

import { basename, relative } from "node:path";
import { createHash } from "node:crypto";
import { getDb } from "./db.js";

export interface ArtifactRow {
  id: string;
  projectPath: string;
  artifactType: string;
  title: string;
  description: string | null;
  filePath: string | null;
  commitSha: string | null;
  sourceSessionId: string;
  createdAt: string;
  updatedAt: string;
  metadataJson: string | null;
}

export interface ArtifactAttachmentRow {
  ownerId: string;
  artifactId: string;
  relationshipType: string;
  confidence: number;
  derivedAt: string;
}

export interface DecisionRow {
  id: string;
  projectPath: string;
  decisionType: string;
  title: string;
  summary: string | null;
  status: string;
  confidence: number;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadataJson: string | null;
}

export interface DecisionEvidenceRow {
  decisionId: string;
  sourceTable: string;
  sourceRowId: string | null;
  snippet: string | null;
  confidence: number;
  createdAt: string;
}

export interface DecisionAttachmentRow {
  ownerId: string;
  decisionId: string;
  relationshipType: string;
  confidence: number;
  derivedAt: string;
}

export interface BlockerRow {
  id: string;
  projectPath: string;
  blockerType: string;
  title: string;
  summary: string | null;
  status: string;
  confidence: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadataJson: string | null;
}

export interface BlockerEvidenceRow {
  blockerId: string;
  sourceTable: string;
  sourceRowId: string | null;
  snippet: string | null;
  confidence: number;
  createdAt: string;
}

export interface BlockerAttachmentRow {
  ownerId: string;
  blockerId: string;
  relationshipType: string;
  confidence: number;
  derivedAt: string;
}

interface ProjectSessionRow {
  id: string;
  projectPath: string;
  lastEventAt: string | null;
}

interface CommitArtifactRow {
  id: number;
  sessionId: string;
  turnIndex: number;
  timestamp: string | null;
  commitMessage: string | null;
  commitSha: string | null;
}

interface FileArtifactRow {
  filePath: string;
  lastTimestamp: string | null;
  touchCount: number;
}

interface FileArtifactSessionRow {
  filePath: string;
  sessionId: string;
}

interface SessionTaskRow {
  sessionId: string;
  taskId: string;
}

interface SessionWorkstreamRow {
  sessionId: string;
  workstreamId: string;
}

interface ApprovalDecisionRow {
  id: number;
  sessionId: string;
  approvalType: string;
  status: string;
  detail: string | null;
  timestamp: string | null;
}

interface BlockedSessionRow {
  sessionId: string;
  status: string;
  blockedReason: string | null;
  pendingApprovalCount: number;
  derivedAt: string;
  lastEventAt: string | null;
}

interface ApprovalEvidenceRow {
  id: number;
  sessionId: string;
  approvalType: string;
  status: string;
  detail: string | null;
  timestamp: string | null;
}

interface ErrorEvidenceRow {
  id: number;
  sessionId: string;
  message: string;
  timestamp: string | null;
}

export function deriveAndStoreM6ForProject(projectPath: string): void {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT
      id,
      project_path as projectPath,
      last_event_at as lastEventAt
    FROM sessions
    WHERE project_path = ?
  `).all(projectPath) as ProjectSessionRow[];
  if (sessions.length === 0) {
    cleanupProjectM6(projectPath);
    return;
  }

  cleanupProjectM6(projectPath);

  const sessionIds = sessions.map((session) => session.id);
  const sessionTasks = db.prepare(`
    SELECT
      session_id as sessionId,
      task_id as taskId
    FROM session_tasks
    WHERE is_active = 1
      AND session_id IN (${sessionIds.map(() => "?").join(", ")})
  `).all(...sessionIds) as SessionTaskRow[];
  const sessionWorkstreams = db.prepare(`
    SELECT
      workstream_sessions.session_id as sessionId,
      workstream_sessions.workstream_id as workstreamId
    FROM workstream_sessions
    JOIN workstreams ON workstreams.id = workstream_sessions.workstream_id
    WHERE workstreams.project_path = ?
  `).all(projectPath) as SessionWorkstreamRow[];

  const taskIdsBySession = groupMultiMap(sessionTasks, (row) => row.sessionId, (row) => row.taskId);
  const workstreamIdsBySession = groupMultiMap(sessionWorkstreams, (row) => row.sessionId, (row) => row.workstreamId);
  const now = new Date().toISOString();

  deriveAndStoreArtifacts({
    projectPath,
    taskIdsBySession,
    workstreamIdsBySession,
    now,
  });

  deriveAndStoreDecisions({
    projectPath,
    taskIdsBySession,
    workstreamIdsBySession,
    now,
  });

  deriveAndStoreBlockers({
    projectPath,
    taskIdsBySession,
    workstreamIdsBySession,
    now,
  });
}

export function listStoredArtifacts(projectPath?: string): ArtifactRow[] {
  const db = getDb();
  const sql = `
    SELECT
      id,
      project_path as projectPath,
      artifact_type as artifactType,
      title,
      description,
      file_path as filePath,
      commit_sha as commitSha,
      source_session_id as sourceSessionId,
      created_at as createdAt,
      updated_at as updatedAt,
      metadata_json as metadataJson
    FROM artifacts
    ${projectPath ? "WHERE project_path = ?" : ""}
    ORDER BY updated_at DESC, title ASC
  `;
  return (projectPath ? db.prepare(sql).all(projectPath) : db.prepare(sql).all()) as ArtifactRow[];
}

export function listStoredTaskArtifacts(taskId?: string): ArtifactAttachmentRow[] {
  return listAttachmentRows("task_artifacts", "task_id", "artifact_id", taskId);
}

export function listStoredSessionArtifacts(sessionId?: string): ArtifactAttachmentRow[] {
  return listAttachmentRows("session_artifacts", "session_id", "artifact_id", sessionId);
}

export function listStoredWorkstreamArtifacts(workstreamId?: string): ArtifactAttachmentRow[] {
  return listAttachmentRows("workstream_artifacts", "workstream_id", "artifact_id", workstreamId);
}

export function listStoredDecisions(projectPath?: string): DecisionRow[] {
  const db = getDb();
  const sql = `
    SELECT
      id,
      project_path as projectPath,
      decision_type as decisionType,
      title,
      summary,
      status,
      confidence,
      decided_at as decidedAt,
      created_at as createdAt,
      updated_at as updatedAt,
      metadata_json as metadataJson
    FROM decisions
    ${projectPath ? "WHERE project_path = ?" : ""}
    ORDER BY updated_at DESC, title ASC
  `;
  return (projectPath ? db.prepare(sql).all(projectPath) : db.prepare(sql).all()) as DecisionRow[];
}

export function listStoredDecisionEvidence(decisionId?: string): DecisionEvidenceRow[] {
  const db = getDb();
  const sql = `
    SELECT
      decision_id as decisionId,
      source_table as sourceTable,
      source_row_id as sourceRowId,
      snippet,
      confidence,
      created_at as createdAt
    FROM decision_evidence
    ${decisionId ? "WHERE decision_id = ?" : ""}
    ORDER BY created_at DESC, id DESC
  `;
  return (decisionId ? db.prepare(sql).all(decisionId) : db.prepare(sql).all()) as DecisionEvidenceRow[];
}

export function listStoredTaskDecisions(taskId?: string): DecisionAttachmentRow[] {
  return listDecisionAttachmentRows("task_decisions", "task_id", taskId);
}

export function listStoredSessionDecisions(sessionId?: string): DecisionAttachmentRow[] {
  return listDecisionAttachmentRows("session_decisions", "session_id", sessionId);
}

export function listStoredWorkstreamDecisions(workstreamId?: string): DecisionAttachmentRow[] {
  return listDecisionAttachmentRows("workstream_decisions", "workstream_id", workstreamId);
}

export function listStoredBlockers(projectPath?: string): BlockerRow[] {
  const db = getDb();
  const sql = `
    SELECT
      id,
      project_path as projectPath,
      blocker_type as blockerType,
      title,
      summary,
      status,
      confidence,
      first_seen_at as firstSeenAt,
      last_seen_at as lastSeenAt,
      created_at as createdAt,
      updated_at as updatedAt,
      metadata_json as metadataJson
    FROM blockers
    ${projectPath ? "WHERE project_path = ?" : ""}
    ORDER BY updated_at DESC, title ASC
  `;
  return (projectPath ? db.prepare(sql).all(projectPath) : db.prepare(sql).all()) as BlockerRow[];
}

export function listStoredBlockerEvidence(blockerId?: string): BlockerEvidenceRow[] {
  const db = getDb();
  const sql = `
    SELECT
      blocker_id as blockerId,
      source_table as sourceTable,
      source_row_id as sourceRowId,
      snippet,
      confidence,
      created_at as createdAt
    FROM blocker_evidence
    ${blockerId ? "WHERE blocker_id = ?" : ""}
    ORDER BY created_at DESC, id DESC
  `;
  return (blockerId ? db.prepare(sql).all(blockerId) : db.prepare(sql).all()) as BlockerEvidenceRow[];
}

export function listStoredTaskBlockers(taskId?: string): BlockerAttachmentRow[] {
  return listBlockerAttachmentRows("task_blockers", "task_id", taskId);
}

export function listStoredSessionBlockers(sessionId?: string): BlockerAttachmentRow[] {
  return listBlockerAttachmentRows("session_blockers", "session_id", sessionId);
}

export function listStoredWorkstreamBlockers(workstreamId?: string): BlockerAttachmentRow[] {
  return listBlockerAttachmentRows("workstream_blockers", "workstream_id", workstreamId);
}

function deriveAndStoreArtifacts(input: {
  projectPath: string;
  taskIdsBySession: Map<string, Set<string>>;
  workstreamIdsBySession: Map<string, Set<string>>;
  now: string;
}): void {
  const db = getDb();
  const commits = db.prepare(`
    SELECT
      commits.id as id,
      commits.session_id as sessionId,
      commits.turn_index as turnIndex,
      commits.timestamp as timestamp,
      commits.commit_message as commitMessage,
      commits.commit_sha as commitSha
    FROM commits
    JOIN sessions ON sessions.id = commits.session_id
    WHERE sessions.project_path = ?
    ORDER BY commits.id ASC
  `).all(input.projectPath) as CommitArtifactRow[];

  for (const commit of commits) {
    const commitKey = commit.commitSha?.trim() || commit.commitMessage?.trim() || `turn:${commit.turnIndex}`;
    const artifactId = makeDeterministicId("artifact", input.projectPath, "commit", commit.sessionId, commitKey);
    const title = commit.commitMessage?.trim()
      ? `Commit: ${commit.commitMessage.trim()}`
      : commit.commitSha
        ? `Commit ${commit.commitSha}`
        : "Commit";
    db.prepare(`
      INSERT OR IGNORE INTO artifacts(
        id, project_path, artifact_type, title, description, file_path, commit_sha, source_session_id,
        created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      input.projectPath,
      "commit",
      title,
      commit.commitMessage ?? null,
      null,
      commit.commitSha ?? null,
      commit.sessionId,
      commit.timestamp ?? input.now,
      input.now,
      JSON.stringify({
        commitSha: commit.commitSha,
      }),
    );

    attachArtifact(artifactId, [commit.sessionId], input.taskIdsBySession, input.workstreamIdsBySession, input.now);
  }

  const fileChanges = db.prepare(`
    SELECT
      file_touches.file_path as filePath,
      MAX(file_touches.timestamp) as lastTimestamp,
      COUNT(*) as touchCount
    FROM file_touches
    JOIN sessions ON sessions.id = file_touches.session_id
    WHERE sessions.project_path = ?
      AND file_touches.file_path IS NOT NULL
      AND file_touches.action IN ('write', 'edit')
    GROUP BY file_touches.file_path
    ORDER BY file_touches.file_path ASC
  `).all(input.projectPath) as FileArtifactRow[];
  const fileSessions = db.prepare(`
    SELECT DISTINCT
      file_touches.file_path as filePath,
      file_touches.session_id as sessionId
    FROM file_touches
    JOIN sessions ON sessions.id = file_touches.session_id
    WHERE sessions.project_path = ?
      AND file_touches.file_path IS NOT NULL
      AND file_touches.action IN ('write', 'edit')
    ORDER BY file_touches.file_path ASC, file_touches.session_id ASC
  `).all(input.projectPath) as FileArtifactSessionRow[];
  const fileSessionsByPath = groupMultiMap(fileSessions, (row) => row.filePath, (row) => row.sessionId);

  for (const file of fileChanges) {
    const artifactId = makeDeterministicId("artifact", input.projectPath, "file", file.filePath);
    const relativePath = safeRelative(input.projectPath, file.filePath);
    const contributingSessions = [...(fileSessionsByPath.get(file.filePath) ?? new Set<string>())];
    if (contributingSessions.length === 0) continue;
    db.prepare(`
      INSERT OR IGNORE INTO artifacts(
        id, project_path, artifact_type, title, description, file_path, commit_sha, source_session_id,
        created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      artifactId,
      input.projectPath,
      "file_change",
      `File change: ${basename(file.filePath)}`,
      relativePath,
      file.filePath,
      null,
      contributingSessions[0],
      file.lastTimestamp ?? input.now,
      input.now,
      JSON.stringify({
        touchCount: file.touchCount,
        sessionCount: contributingSessions.length,
      }),
    );

    attachArtifact(artifactId, contributingSessions, input.taskIdsBySession, input.workstreamIdsBySession, input.now);
  }
}

function deriveAndStoreDecisions(input: {
  projectPath: string;
  taskIdsBySession: Map<string, Set<string>>;
  workstreamIdsBySession: Map<string, Set<string>>;
  now: string;
}): void {
  const db = getDb();
  const approvals = db.prepare(`
    SELECT
      approvals.id as id,
      approvals.session_id as sessionId,
      approvals.approval_type as approvalType,
      approvals.status as status,
      approvals.detail as detail,
      approvals.timestamp as timestamp
    FROM approvals
    JOIN sessions ON sessions.id = approvals.session_id
    WHERE sessions.project_path = ?
    ORDER BY approvals.id ASC
  `).all(input.projectPath) as ApprovalDecisionRow[];

  for (const approval of approvals) {
    const decisionId = makeDeterministicId(
      "decision",
      input.projectPath,
      approval.sessionId,
      approval.approvalType,
      approval.status,
      approval.timestamp ?? `${approval.approvalType}:${approval.status}`,
      approval.detail ?? "",
    );
    const title = `${capitalize(approval.approvalType)} ${approval.status}`;
    const confidence = approval.status === "rejected" ? 0.94 : 0.7;
    db.prepare(`
      INSERT OR IGNORE INTO decisions(
        id, project_path, decision_type, title, summary, status, confidence, decided_at, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      input.projectPath,
      `${approval.approvalType}_approval`,
      title,
      approval.detail ?? null,
      approval.status,
      confidence,
      approval.timestamp ?? input.now,
      approval.timestamp ?? input.now,
      input.now,
      JSON.stringify({
        approvalType: approval.approvalType,
      }),
    );
    db.prepare(`
      INSERT INTO decision_evidence(decision_id, source_table, source_row_id, snippet, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      "approvals",
      String(approval.id),
      approval.detail ?? `${approval.approvalType} ${approval.status}`,
      confidence,
      input.now,
    );

    attachDecision(decisionId, approval.sessionId, input.taskIdsBySession, input.workstreamIdsBySession, input.now);
  }
}

function deriveAndStoreBlockers(input: {
  projectPath: string;
  taskIdsBySession: Map<string, Set<string>>;
  workstreamIdsBySession: Map<string, Set<string>>;
  now: string;
}): void {
  const db = getDb();
  const blockedSessions = db.prepare(`
    SELECT
      session_state.session_id as sessionId,
      session_state.status as status,
      session_state.blocked_reason as blockedReason,
      session_state.pending_approval_count as pendingApprovalCount,
      session_state.derived_at as derivedAt,
      session_state.last_event_at as lastEventAt
    FROM session_state
    JOIN sessions ON sessions.id = session_state.session_id
    WHERE sessions.project_path = ?
      AND session_state.status IN ('blocked', 'stalled')
  `).all(input.projectPath) as BlockedSessionRow[];
  const approvals = db.prepare(`
    SELECT
      approvals.id as id,
      approvals.session_id as sessionId,
      approvals.approval_type as approvalType,
      approvals.status as status,
      approvals.detail as detail,
      approvals.timestamp as timestamp
    FROM approvals
    JOIN sessions ON sessions.id = approvals.session_id
    WHERE sessions.project_path = ?
    ORDER BY approvals.id DESC
  `).all(input.projectPath) as ApprovalEvidenceRow[];
  const errors = db.prepare(`
    SELECT
      errors.id as id,
      errors.session_id as sessionId,
      errors.message as message,
      errors.timestamp as timestamp
    FROM errors
    JOIN sessions ON sessions.id = errors.session_id
    WHERE sessions.project_path = ?
    ORDER BY errors.id DESC
  `).all(input.projectPath) as ErrorEvidenceRow[];

  const approvalsBySession = groupBy(approvals, (row) => row.sessionId);
  const errorsBySession = groupBy(errors, (row) => row.sessionId);

  for (const session of blockedSessions) {
    const blockerType = deriveBlockerType(session, approvalsBySession.get(session.sessionId) ?? [], errorsBySession.get(session.sessionId) ?? []);
    const blockerId = makeDeterministicId("blocker", input.projectPath, session.sessionId, blockerType, session.blockedReason ?? "");
    const title = blockerType === "approval_rejected"
      ? "Approval rejected"
      : blockerType === "approval_pending"
        ? "Approval pending"
        : "Session stalled on error";

    db.prepare(`
      INSERT OR IGNORE INTO blockers(
        id, project_path, blocker_type, title, summary, status, confidence, first_seen_at, last_seen_at, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      blockerId,
      input.projectPath,
      blockerType,
      title,
      session.blockedReason ?? null,
      "active",
      blockerType === "error_stall" ? 0.84 : 0.9,
      session.lastEventAt ?? session.derivedAt,
      session.lastEventAt ?? session.derivedAt,
      session.derivedAt,
      input.now,
      JSON.stringify({
        sessionStatus: session.status,
        pendingApprovalCount: session.pendingApprovalCount,
      }),
    );
    db.prepare(`
      INSERT INTO blocker_evidence(blocker_id, source_table, source_row_id, snippet, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      blockerId,
      "session_state",
      session.sessionId,
      session.blockedReason ?? session.status,
      blockerType === "error_stall" ? 0.84 : 0.9,
      input.now,
    );

    const recentApproval = (approvalsBySession.get(session.sessionId) ?? []).find((row) =>
      blockerType === "approval_pending"
        ? true
        : blockerType === "approval_rejected"
          ? row.status === "rejected"
          : false,
    );
    if (recentApproval) {
      db.prepare(`
        INSERT INTO blocker_evidence(blocker_id, source_table, source_row_id, snippet, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        blockerId,
        "approvals",
        String(recentApproval.id),
        recentApproval.detail ?? `${recentApproval.approvalType} ${recentApproval.status}`,
        0.9,
        input.now,
      );
    }

    const recentError = blockerType === "error_stall" ? (errorsBySession.get(session.sessionId) ?? [])[0] : null;
    if (recentError) {
      db.prepare(`
        INSERT INTO blocker_evidence(blocker_id, source_table, source_row_id, snippet, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        blockerId,
        "errors",
        String(recentError.id),
        recentError.message,
        0.86,
        input.now,
      );
    }

    attachBlocker(blockerId, session.sessionId, input.taskIdsBySession, input.workstreamIdsBySession, input.now);
  }
}

function attachArtifact(
  artifactId: string,
  sessionIds: string[],
  taskIdsBySession: Map<string, Set<string>>,
  workstreamIdsBySession: Map<string, Set<string>>,
  now: string,
): void {
  const db = getDb();
  const seenTaskIds = new Set<string>();
  const seenWorkstreamIds = new Set<string>();
  for (const sessionId of sessionIds) {
    db.prepare(`
      INSERT OR IGNORE INTO session_artifacts(session_id, artifact_id, relationship_type, confidence, derived_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, artifactId, "produced_in", 0.95, now);

    for (const taskId of taskIdsBySession.get(sessionId) ?? []) {
      if (seenTaskIds.has(taskId)) continue;
      seenTaskIds.add(taskId);
      db.prepare(`
        INSERT OR IGNORE INTO task_artifacts(task_id, artifact_id, relationship_type, confidence, derived_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(taskId, artifactId, "supports", 0.86, now);
    }

    for (const workstreamId of workstreamIdsBySession.get(sessionId) ?? []) {
      if (seenWorkstreamIds.has(workstreamId)) continue;
      seenWorkstreamIds.add(workstreamId);
      db.prepare(`
        INSERT OR IGNORE INTO workstream_artifacts(workstream_id, artifact_id, relationship_type, confidence, derived_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(workstreamId, artifactId, "supports", 0.82, now);
    }
  }
}

function attachDecision(
  decisionId: string,
  sessionId: string,
  taskIdsBySession: Map<string, Set<string>>,
  workstreamIdsBySession: Map<string, Set<string>>,
  now: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO session_decisions(session_id, decision_id, relationship_type, confidence, derived_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, decisionId, "made_in", 0.95, now);

  for (const taskId of taskIdsBySession.get(sessionId) ?? []) {
    db.prepare(`
      INSERT OR IGNORE INTO task_decisions(task_id, decision_id, relationship_type, confidence, derived_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, decisionId, "affects", 0.84, now);
  }

  for (const workstreamId of workstreamIdsBySession.get(sessionId) ?? []) {
    db.prepare(`
      INSERT OR IGNORE INTO workstream_decisions(workstream_id, decision_id, relationship_type, confidence, derived_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workstreamId, decisionId, "affects", 0.8, now);
  }
}

function attachBlocker(
  blockerId: string,
  sessionId: string,
  taskIdsBySession: Map<string, Set<string>>,
  workstreamIdsBySession: Map<string, Set<string>>,
  now: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO session_blockers(session_id, blocker_id, relationship_type, confidence, derived_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, blockerId, "blocks", 0.96, now);

  for (const taskId of taskIdsBySession.get(sessionId) ?? []) {
    db.prepare(`
      INSERT OR IGNORE INTO task_blockers(task_id, blocker_id, relationship_type, confidence, derived_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, blockerId, "blocks", 0.9, now);
  }

  for (const workstreamId of workstreamIdsBySession.get(sessionId) ?? []) {
    db.prepare(`
      INSERT OR IGNORE INTO workstream_blockers(workstream_id, blocker_id, relationship_type, confidence, derived_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workstreamId, blockerId, "blocks", 0.86, now);
  }
}

function cleanupProjectM6(projectPath: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM artifacts WHERE project_path = ?`).run(projectPath);
  db.prepare(`DELETE FROM decisions WHERE project_path = ?`).run(projectPath);
  db.prepare(`DELETE FROM blockers WHERE project_path = ?`).run(projectPath);
}

function listAttachmentRows(
  table: string,
  ownerColumn: string,
  valueColumn: string,
  ownerId?: string,
): ArtifactAttachmentRow[] {
  const db = getDb();
  const sql = `
    SELECT
      ${ownerColumn} as ownerId,
      ${valueColumn} as artifactId,
      relationship_type as relationshipType,
      confidence,
      derived_at as derivedAt
    FROM ${table}
    ${ownerId ? `WHERE ${ownerColumn} = ?` : ""}
    ORDER BY derived_at DESC, ${valueColumn} ASC
  `;
  return (ownerId ? db.prepare(sql).all(ownerId) : db.prepare(sql).all()) as ArtifactAttachmentRow[];
}

function listDecisionAttachmentRows(
  table: string,
  ownerColumn: string,
  ownerId?: string,
): DecisionAttachmentRow[] {
  const db = getDb();
  const sql = `
    SELECT
      ${ownerColumn} as ownerId,
      decision_id as decisionId,
      relationship_type as relationshipType,
      confidence,
      derived_at as derivedAt
    FROM ${table}
    ${ownerId ? `WHERE ${ownerColumn} = ?` : ""}
    ORDER BY derived_at DESC, decision_id ASC
  `;
  return (ownerId ? db.prepare(sql).all(ownerId) : db.prepare(sql).all()) as DecisionAttachmentRow[];
}

function listBlockerAttachmentRows(
  table: string,
  ownerColumn: string,
  ownerId?: string,
): BlockerAttachmentRow[] {
  const db = getDb();
  const sql = `
    SELECT
      ${ownerColumn} as ownerId,
      blocker_id as blockerId,
      relationship_type as relationshipType,
      confidence,
      derived_at as derivedAt
    FROM ${table}
    ${ownerId ? `WHERE ${ownerColumn} = ?` : ""}
    ORDER BY derived_at DESC, blocker_id ASC
  `;
  return (ownerId ? db.prepare(sql).all(ownerId) : db.prepare(sql).all()) as BlockerAttachmentRow[];
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

function makeDeterministicId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function safeRelative(projectPath: string, filePath: string): string {
  const rel = relative(projectPath, filePath);
  return rel.startsWith("..") ? filePath : rel;
}

function deriveBlockerType(
  session: BlockedSessionRow,
  approvals: ApprovalEvidenceRow[],
  errors: ErrorEvidenceRow[],
): string {
  if (session.pendingApprovalCount > 0) {
    return "approval_pending";
  }
  if (approvals.some((approval) => approval.status === "rejected")) {
    return "approval_rejected";
  }
  if (session.status === "stalled" || errors.length > 0) {
    return "error_stall";
  }
  return "session_blocked";
}

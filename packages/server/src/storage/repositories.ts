import type { SessionInfo } from "../types/index.js";
import type { AgentProvider, ProviderSessionRef, SessionLifecycle } from "../providers/types.js";
import { toProviderSessionRef } from "../providers/types.js";
import { getDb } from "./db.js";

export const STORAGE_PARSER_VERSION = process.env.HEXDECK_STORAGE_PARSER_VERSION ?? "m5-workstreams-v2";

export interface TranscriptSourceRow {
  id: number;
  sourceType: string;
  sessionId: string;
  filePath: string;
  fileSizeBytes: number;
  fileMtime: string | null;
  discoveredAt: string;
  lastSeenAt: string;
  isActive: boolean;
}

export interface IngestionCheckpointRow {
  id: number;
  transcriptSourceId: number;
  parserVersion: string;
  lastProcessedLine: number;
  lastProcessedByteOffset: number;
  lastProcessedTimestamp: string | null;
  lastIngestedAt: string;
  status: string;
  errorMessage: string | null;
}

export interface IngestionCheckpointProgress {
  lastProcessedLine: number;
  lastProcessedByteOffset: number;
  lastProcessedTimestamp: string | null;
}

export interface StoredSessionRow {
  id: string;
  sourceType: string;
  transcriptSourceId: number | null;
  projectPath: string;
  cwd: string;
  gitBranch: string | null;
  createdAt: string;
  lastEventAt: string;
  endedAt: string | null;
  status: string;
  endReason: string | null;
  metadataJson: string | null;
}

export function upsertTranscriptSource(ref: ProviderSessionRef): number {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO transcript_sources(
      source_type,
      session_id,
      file_path,
      file_size_bytes,
      file_mtime,
      discovered_at,
      last_seen_at,
      is_active
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(source_type, session_id) DO UPDATE SET
      file_path = excluded.file_path,
      file_size_bytes = excluded.file_size_bytes,
      file_mtime = excluded.file_mtime,
      last_seen_at = excluded.last_seen_at,
      is_active = 1
  `).run(
    ref.provider,
    ref.id,
    ref.sourcePath,
    ref.sourceSizeBytes,
    ref.sourceMtime.toISOString(),
    now,
    now,
  );

  const row = db.prepare(`
    SELECT id
    FROM transcript_sources
    WHERE source_type = ? AND session_id = ?
  `).get(ref.provider, ref.id) as { id: number } | undefined;

  if (!row) {
    throw new Error(`Failed to upsert transcript source for ${ref.provider} session ${ref.id}`);
  }

  return row.id;
}

export function upsertClaudeTranscriptSource(session: SessionInfo): number {
  return upsertTranscriptSource(toProviderSessionRef("claude", session));
}

export function ensureIngestionCheckpoint(transcriptSourceId: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO ingestion_checkpoints(
      transcript_source_id,
      parser_version,
      last_processed_line,
      last_processed_byte_offset,
      last_processed_timestamp,
      last_ingested_at,
      status,
      error_message
    )
    VALUES (?, ?, 0, 0, NULL, ?, 'pending', NULL)
    ON CONFLICT(transcript_source_id) DO UPDATE SET
      parser_version = excluded.parser_version,
      last_processed_line = CASE
        WHEN ingestion_checkpoints.parser_version != excluded.parser_version THEN 0
        ELSE ingestion_checkpoints.last_processed_line
      END,
      last_processed_byte_offset = CASE
        WHEN ingestion_checkpoints.parser_version != excluded.parser_version THEN 0
        ELSE ingestion_checkpoints.last_processed_byte_offset
      END,
      last_processed_timestamp = CASE
        WHEN ingestion_checkpoints.parser_version != excluded.parser_version THEN NULL
        ELSE ingestion_checkpoints.last_processed_timestamp
      END,
      status = CASE
        WHEN ingestion_checkpoints.parser_version != excluded.parser_version THEN 'pending'
        ELSE ingestion_checkpoints.status
      END,
      error_message = CASE
        WHEN ingestion_checkpoints.parser_version != excluded.parser_version THEN NULL
        ELSE ingestion_checkpoints.error_message
      END,
      last_ingested_at = CASE
        WHEN ingestion_checkpoints.parser_version != excluded.parser_version THEN excluded.last_ingested_at
        ELSE ingestion_checkpoints.last_ingested_at
      END
  `).run(
    transcriptSourceId,
    STORAGE_PARSER_VERSION,
    new Date().toISOString(),
  );
}

export function ensureClaudeIngestionCheckpoint(transcriptSourceId: number): void {
  ensureIngestionCheckpoint(transcriptSourceId);
}

export function getIngestionCheckpoint(
  transcriptSourceId: number,
): IngestionCheckpointRow | null {
  const db = getDb();
  return db.prepare(`
    SELECT
      id,
      transcript_source_id as transcriptSourceId,
      parser_version as parserVersion,
      last_processed_line as lastProcessedLine,
      last_processed_byte_offset as lastProcessedByteOffset,
      last_processed_timestamp as lastProcessedTimestamp,
      last_ingested_at as lastIngestedAt,
      status,
      error_message as errorMessage
    FROM ingestion_checkpoints
    WHERE transcript_source_id = ?
  `).get(transcriptSourceId) as IngestionCheckpointRow | null;
}

export function getClaudeIngestionCheckpoint(
  transcriptSourceId: number,
): IngestionCheckpointRow | null {
  return getIngestionCheckpoint(transcriptSourceId);
}

export function markIngestionCheckpointStatus(
  transcriptSourceId: number,
  status: "pending" | "processing" | "ready" | "error",
  errorMessage: string | null = null,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE ingestion_checkpoints
    SET
      status = ?,
      error_message = ?,
      last_ingested_at = ?
    WHERE transcript_source_id = ?
  `).run(status, errorMessage, new Date().toISOString(), transcriptSourceId);
}

export function markClaudeIngestionCheckpointStatus(
  transcriptSourceId: number,
  status: "pending" | "processing" | "ready" | "error",
  errorMessage: string | null = null,
): void {
  markIngestionCheckpointStatus(transcriptSourceId, status, errorMessage);
}

export function resetIngestionCheckpoint(
  transcriptSourceId: number,
  status: "pending" | "error" = "pending",
  errorMessage: string | null = null,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE ingestion_checkpoints
    SET
      last_processed_line = 0,
      last_processed_byte_offset = 0,
      last_processed_timestamp = NULL,
      last_ingested_at = ?,
      status = ?,
      error_message = ?
    WHERE transcript_source_id = ?
  `).run(new Date().toISOString(), status, errorMessage, transcriptSourceId);
}

export function resetClaudeIngestionCheckpoint(
  transcriptSourceId: number,
  status: "pending" | "error" = "pending",
  errorMessage: string | null = null,
): void {
  resetIngestionCheckpoint(transcriptSourceId, status, errorMessage);
}

export function updateIngestionCheckpointProgress(
  transcriptSourceId: number,
  progress: IngestionCheckpointProgress,
  status: "ready" | "pending" = "ready",
): void {
  const db = getDb();
  db.prepare(`
    UPDATE ingestion_checkpoints
    SET
      last_processed_line = ?,
      last_processed_byte_offset = ?,
      last_processed_timestamp = ?,
      last_ingested_at = ?,
      status = ?,
      error_message = NULL
    WHERE transcript_source_id = ?
  `).run(
    progress.lastProcessedLine,
    progress.lastProcessedByteOffset,
    progress.lastProcessedTimestamp,
    new Date().toISOString(),
    status,
    transcriptSourceId,
  );
}

export function updateClaudeIngestionCheckpointProgress(
  transcriptSourceId: number,
  progress: IngestionCheckpointProgress,
  status: "ready" | "pending" = "ready",
): void {
  updateIngestionCheckpointProgress(transcriptSourceId, progress, status);
}

export function upsertSession(
  ref: ProviderSessionRef,
  transcriptSourceId: number,
  lifecycle?: SessionLifecycle,
): void {
  const db = getDb();
  const metadata = {
    ...readSessionMetadata(ref.id),
    provider: ref.provider,
    path: ref.sourcePath,
    sizeBytes: ref.sourceSizeBytes,
  };
  db.prepare(`
    INSERT INTO sessions(
      id,
      source_type,
      transcript_source_id,
      project_path,
      cwd,
      git_branch,
      created_at,
      last_event_at,
      ended_at,
      status,
      end_reason,
      metadata_json
    )
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'discovered', NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_type = CASE WHEN sessions.status = 'ended' THEN sessions.source_type ELSE excluded.source_type END,
      transcript_source_id = CASE WHEN sessions.status = 'ended' THEN sessions.transcript_source_id ELSE excluded.transcript_source_id END,
      project_path = CASE WHEN sessions.status = 'ended' THEN sessions.project_path ELSE excluded.project_path END,
      cwd = CASE WHEN sessions.status = 'ended' THEN sessions.cwd ELSE excluded.cwd END,
      last_event_at = CASE WHEN sessions.status = 'ended' THEN sessions.last_event_at ELSE excluded.last_event_at END,
      metadata_json = CASE WHEN sessions.status = 'ended' THEN sessions.metadata_json ELSE excluded.metadata_json END
  `).run(
    ref.id,
    ref.provider,
    transcriptSourceId,
    ref.projectPath,
    // TODO: populate cwd from transcript parsing once the parsed evidence layer lands.
    ref.projectPath,
    ref.createdAt.toISOString(),
    ref.modifiedAt.toISOString(),
    JSON.stringify(metadata),
  );

  if (lifecycle) {
    db.prepare(`
      UPDATE sessions
      SET status = ?, ended_at = ?, end_reason = ?
      WHERE id = ? AND COALESCE(status, '') != 'ended'
    `).run(lifecycle.status, lifecycle.endedAt, lifecycle.endReason, ref.id);
  }
}

export function upsertClaudeSession(session: SessionInfo, transcriptSourceId: number): void {
  upsertSession(toProviderSessionRef("claude", session), transcriptSourceId);
}

function readSessionMetadata(sessionId: string): Record<string, unknown> {
  const row = getDb().prepare(`
    SELECT metadata_json as metadataJson
    FROM sessions
    WHERE id = ?
  `).get(sessionId) as { metadataJson: string | null } | undefined;
  if (!row?.metadataJson) return {};
  try {
    const parsed = JSON.parse(row.metadataJson);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function markMissingTranscriptSourcesInactive(
  provider: AgentProvider,
  activeSessionIds: string[],
): void {
  const db = getDb();
  if (activeSessionIds.length === 0) {
    db.prepare(`
      UPDATE transcript_sources
      SET is_active = 0
      WHERE source_type = ? AND is_active = 1
    `).run(provider);
    return;
  }

  const placeholders = activeSessionIds.map(() => "?").join(", ");
  db.prepare(`
    UPDATE transcript_sources
    SET is_active = 0
    WHERE source_type = ?
      AND is_active = 1
      AND session_id NOT IN (${placeholders})
  `).run(provider, ...activeSessionIds);
}

export function markMissingClaudeTranscriptSourcesInactive(activeSessionIds: string[]): void {
  markMissingTranscriptSourcesInactive("claude", activeSessionIds);
}

export function listStoredSessions(provider?: AgentProvider): StoredSessionRow[] {
  const db = getDb();
  const sql = `
    SELECT
      id,
      source_type as sourceType,
      transcript_source_id as transcriptSourceId,
      project_path as projectPath,
      cwd,
      git_branch as gitBranch,
      created_at as createdAt,
      last_event_at as lastEventAt,
      ended_at as endedAt,
      status,
      end_reason as endReason,
      metadata_json as metadataJson
    FROM sessions
    ${provider ? "WHERE source_type = ?" : ""}
    ORDER BY last_event_at DESC
  `;
  return (provider ? db.prepare(sql).all(provider) : db.prepare(sql).all()) as StoredSessionRow[];
}

export function getStoredSessionRef(sessionId: string): ProviderSessionRef | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      s.id as id,
      s.source_type as sourceType,
      s.project_path as projectPath,
      s.created_at as createdAt,
      s.last_event_at as lastEventAt,
      t.file_path as filePath,
      t.file_size_bytes as fileSizeBytes,
      t.file_mtime as fileMtime
    FROM sessions s
    LEFT JOIN transcript_sources t ON t.id = s.transcript_source_id
    WHERE s.id = ?
  `).get(sessionId) as
    | {
        id: string;
        sourceType: string;
        projectPath: string;
        createdAt: string;
        lastEventAt: string;
        filePath: string | null;
        fileSizeBytes: number | null;
        fileMtime: string | null;
      }
    | undefined;

  if (!row || !row.filePath) return null;
  if (row.sourceType !== "claude" && row.sourceType !== "codex") return null;

  const createdAt = new Date(row.createdAt);
  const mtimeSource = row.fileMtime ?? row.lastEventAt;
  const modifiedAt = new Date(mtimeSource);
  const sizeBytes = row.fileSizeBytes ?? 0;

  return {
    id: row.id,
    path: row.filePath,
    projectPath: row.projectPath,
    createdAt,
    modifiedAt,
    sizeBytes,
    provider: row.sourceType,
    sourcePath: row.filePath,
    sourceMtime: modifiedAt,
    sourceSizeBytes: sizeBytes,
  };
}

export function listStoredClaudeSessions(): StoredSessionRow[] {
  return listStoredSessions("claude");
}

export function listTranscriptSources(): TranscriptSourceRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      id,
      source_type as sourceType,
      session_id as sessionId,
      file_path as filePath,
      file_size_bytes as fileSizeBytes,
      file_mtime as fileMtime,
      discovered_at as discoveredAt,
      last_seen_at as lastSeenAt,
      is_active as isActive
    FROM transcript_sources
    ORDER BY last_seen_at DESC
  `).all() as TranscriptSourceRow[];
}

export function listIngestionCheckpoints(): IngestionCheckpointRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      id,
      transcript_source_id as transcriptSourceId,
      parser_version as parserVersion,
      last_processed_line as lastProcessedLine,
      last_processed_byte_offset as lastProcessedByteOffset,
      last_processed_timestamp as lastProcessedTimestamp,
      last_ingested_at as lastIngestedAt,
      status,
      error_message as errorMessage
    FROM ingestion_checkpoints
    ORDER BY id ASC
  `).all() as IngestionCheckpointRow[];
}

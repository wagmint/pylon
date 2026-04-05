import type { SessionInfo } from "../types/index.js";
import { getDb, withTransaction } from "./db.js";

export const STORAGE_PARSER_VERSION = "m2-baseline-v1";

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
  metadataJson: string | null;
}

export function upsertClaudeTranscriptSource(session: SessionInfo): number {
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
    "claude",
    session.id,
    session.path,
    session.sizeBytes,
    session.modifiedAt.toISOString(),
    now,
    now,
  );

  const row = db.prepare(`
    SELECT id
    FROM transcript_sources
    WHERE source_type = ? AND session_id = ?
  `).get("claude", session.id) as { id: number } | undefined;

  if (!row) {
    throw new Error(`Failed to upsert transcript source for session ${session.id}`);
  }

  return row.id;
}

export function ensureClaudeIngestionCheckpoint(transcriptSourceId: number): void {
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
      last_ingested_at = excluded.last_ingested_at
  `).run(
    transcriptSourceId,
    STORAGE_PARSER_VERSION,
    new Date().toISOString(),
  );
}

export function upsertClaudeSession(session: SessionInfo, transcriptSourceId: number): void {
  const db = getDb();
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
      metadata_json
    )
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'discovered', ?)
    ON CONFLICT(id) DO UPDATE SET
      transcript_source_id = excluded.transcript_source_id,
      project_path = excluded.project_path,
      cwd = excluded.cwd,
      last_event_at = excluded.last_event_at,
      metadata_json = excluded.metadata_json
  `).run(
    session.id,
    "claude",
    transcriptSourceId,
    session.projectPath,
    // TODO: populate cwd from transcript parsing once the parsed evidence layer lands.
    session.projectPath,
    session.createdAt.toISOString(),
    session.modifiedAt.toISOString(),
    JSON.stringify({
      path: session.path,
      sizeBytes: session.sizeBytes,
    }),
  );
}

export function markMissingClaudeTranscriptSourcesInactive(activeSessionIds: string[]): void {
  const db = getDb();
  const activeSet = new Set(activeSessionIds);
  const rows = db.prepare(`
    SELECT id, session_id
    FROM transcript_sources
    WHERE source_type = 'claude' AND is_active = 1
  `).all() as Array<{ id: number; session_id: string }>;

  for (const row of rows) {
    if (activeSet.has(row.session_id)) continue;
    db.prepare(`
      UPDATE transcript_sources
      SET is_active = 0
      WHERE id = ?
    `).run(row.id);
  }
}

export function listStoredClaudeSessions(): StoredSessionRow[] {
  const db = getDb();
  return db.prepare(`
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
      metadata_json as metadataJson
    FROM sessions
    WHERE source_type = 'claude'
    ORDER BY last_event_at DESC
  `).all() as StoredSessionRow[];
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

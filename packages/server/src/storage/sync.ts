import { readFileSync, statSync } from "node:fs";
import { listProjects, listSessions } from "../discovery/sessions.js";
import { withTransaction } from "./db.js";
import {
  ensureClaudeIngestionCheckpoint,
  getClaudeIngestionCheckpoint,
  markClaudeIngestionCheckpointStatus,
  markMissingClaudeTranscriptSourcesInactive,
  resetClaudeIngestionCheckpoint,
  STORAGE_PARSER_VERSION,
  updateClaudeIngestionCheckpointProgress,
  upsertClaudeSession,
  upsertClaudeTranscriptSource,
} from "./repositories.js";

export interface StorageSyncStatus {
  phase: "initializing" | "syncing" | "ready" | "rebuilding" | "error";
  lastSyncedAt: string | null;
  projectCount: number;
  sessionCount: number;
  errorMessage: string | null;
}

let lastSyncStatus: StorageSyncStatus = {
  phase: "initializing",
  lastSyncedAt: null,
  projectCount: 0,
  sessionCount: 0,
  errorMessage: null,
};

export function syncClaudeSessionsToStorage(
  phase: "syncing" | "rebuilding" = "syncing",
): { projectCount: number; sessionCount: number } {
  lastSyncStatus = {
    ...lastSyncStatus,
    phase,
    errorMessage: null,
  };

  try {
    const projects = listProjects();
    const seenSessionIds: string[] = [];

    withTransaction(() => {
      for (const project of projects) {
        const sessions = listSessions(project.encodedName);
        for (const session of sessions) {
          const transcriptSourceId = upsertClaudeTranscriptSource(session);
          ensureClaudeIngestionCheckpoint(transcriptSourceId);
          ingestClaudeTranscriptSource(session.path, transcriptSourceId);
          upsertClaudeSession(session, transcriptSourceId);
          seenSessionIds.push(session.id);
        }
      }

      markMissingClaudeTranscriptSourcesInactive(seenSessionIds);
    });

    const result = {
      projectCount: projects.length,
      sessionCount: seenSessionIds.length,
    };
    lastSyncStatus = {
      phase: "ready",
      lastSyncedAt: new Date().toISOString(),
      errorMessage: null,
      ...result,
    };
    return result;
  } catch (error) {
    lastSyncStatus = {
      ...lastSyncStatus,
      phase: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

export function getStorageSyncStatus(): StorageSyncStatus {
  return lastSyncStatus;
}

function ingestClaudeTranscriptSource(filePath: string, transcriptSourceId: number): void {
  const checkpoint = getClaudeIngestionCheckpoint(transcriptSourceId);
  if (!checkpoint) {
    throw new Error(`Missing ingestion checkpoint for transcript source ${transcriptSourceId}`);
  }

  const fileStat = statSync(filePath);
  const fileSizeBytes = fileStat.size;
  const parserVersionChanged = checkpoint.parserVersion !== STORAGE_PARSER_VERSION;
  const fileShrank = checkpoint.lastProcessedByteOffset > fileSizeBytes;

  if (parserVersionChanged || fileShrank) {
    resetClaudeIngestionCheckpoint(transcriptSourceId);
  }

  const current = getClaudeIngestionCheckpoint(transcriptSourceId);
  if (!current) {
    throw new Error(`Failed to reload ingestion checkpoint for transcript source ${transcriptSourceId}`);
  }

  if (
    current.parserVersion === STORAGE_PARSER_VERSION &&
    current.lastProcessedByteOffset === fileSizeBytes &&
    current.status === "ready"
  ) {
    return;
  }

  markClaudeIngestionCheckpointStatus(transcriptSourceId, "processing");

  try {
    const progress = readClaudeTranscriptProgress(filePath, current.lastProcessedByteOffset, current.lastProcessedLine);
    updateClaudeIngestionCheckpointProgress(transcriptSourceId, progress, "ready");
  } catch (error) {
    markClaudeIngestionCheckpointStatus(
      transcriptSourceId,
      "error",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

function readClaudeTranscriptProgress(
  filePath: string,
  startByteOffset: number,
  existingLineCount: number,
): {
  lastProcessedLine: number;
  lastProcessedByteOffset: number;
  lastProcessedTimestamp: string | null;
} {
  const buffer = readFileSync(filePath);
  const nextOffset = Math.max(0, Math.min(startByteOffset, buffer.length));
  const chunk = buffer.subarray(nextOffset).toString("utf-8");
  const appendedLines = chunk.split("\n").filter((line) => line.length > 0);
  const totalLines = existingLineCount + appendedLines.length;
  const lastProcessedTimestamp = extractLastTranscriptTimestamp(appendedLines);

  return {
    lastProcessedLine: totalLines,
    lastProcessedByteOffset: buffer.length,
    lastProcessedTimestamp,
  };
}

function extractLastTranscriptTimestamp(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as { timestamp?: unknown };
      if (typeof parsed.timestamp === "string") {
        return parsed.timestamp;
      }
    } catch {
      // Ignore malformed lines in the foundation track. Typed evidence parsing
      // lands in the next milestone.
    }
  }
  return null;
}

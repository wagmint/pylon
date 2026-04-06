import { statSync } from "node:fs";
import { listProjects, listSessions } from "../discovery/sessions.js";
import type { SessionInfo } from "../types/index.js";
import { withTransaction } from "./db.js";
import { replaceClaudeParsedEvidence } from "./evidence.js";
import { deriveAndStoreSessionState } from "./session-state.js";
import { deriveAndStoreTasksForSession } from "./tasks.js";
import { deriveAndStoreWorkstreamsForProject } from "./workstreams.js";
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
    const seenProjectPaths = new Set<string>();

    withTransaction(() => {
      for (const project of projects) {
        const sessions = listSessions(project.encodedName);
        for (const session of sessions) {
          const transcriptSourceId = upsertClaudeTranscriptSource(session);
          ensureClaudeIngestionCheckpoint(transcriptSourceId);
          upsertClaudeSession(session, transcriptSourceId);
          ingestClaudeTranscriptSource(session, transcriptSourceId);
          deriveAndStoreSessionState(session.id);
          deriveAndStoreTasksForSession(session.id);
          seenSessionIds.push(session.id);
          seenProjectPaths.add(session.projectPath);
        }
      }

      for (const projectPath of seenProjectPaths) {
        deriveAndStoreWorkstreamsForProject(projectPath);
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

function ingestClaudeTranscriptSource(session: SessionInfo, transcriptSourceId: number): void {
  const checkpoint = getClaudeIngestionCheckpoint(transcriptSourceId);
  if (!checkpoint) {
    throw new Error(`Missing ingestion checkpoint for transcript source ${transcriptSourceId}`);
  }

  const fileStat = statSync(session.path);
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
    const progress = replaceClaudeParsedEvidence(session);
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

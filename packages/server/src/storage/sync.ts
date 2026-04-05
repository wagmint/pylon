import { listProjects, listSessions } from "../discovery/sessions.js";
import {
  ensureClaudeIngestionCheckpoint,
  markMissingClaudeTranscriptSourcesInactive,
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

    for (const project of projects) {
      const sessions = listSessions(project.encodedName);
      for (const session of sessions) {
        const transcriptSourceId = upsertClaudeTranscriptSource(session);
        ensureClaudeIngestionCheckpoint(transcriptSourceId);
        upsertClaudeSession(session, transcriptSourceId);
        seenSessionIds.push(session.id);
      }
    }

    markMissingClaudeTranscriptSourcesInactive(seenSessionIds);

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

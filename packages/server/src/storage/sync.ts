import { statSync } from "node:fs";
import { listProjects, listSessions } from "../providers/claude/discovery.js";
import type { AgentProviderAdapter, ProviderSessionRef } from "../providers/types.js";
import { toProviderSessionRef } from "../providers/types.js";
import { withTransaction } from "./db.js";
import { replaceParsedEvidence } from "./evidence.js";
import { deriveAndStoreSessionState } from "./session-state.js";
import { deriveAndStoreTasksForSession } from "./tasks.js";
import { deriveAndStoreWorkstreamsForProject } from "./workstreams.js";
import { deriveAndStoreM6ForProject } from "./m6.js";
import { deriveAndStoreHandoffsForProject } from "./handoffs.js";
import {
  ensureIngestionCheckpoint,
  getIngestionCheckpoint,
  markIngestionCheckpointStatus,
  markMissingTranscriptSourcesInactive,
  resetIngestionCheckpoint,
  STORAGE_PARSER_VERSION,
  updateIngestionCheckpointProgress,
  upsertSession,
  upsertTranscriptSource,
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
  const projects = listProjects();
  const sessions: ProviderSessionRef[] = [];
  for (const project of projects) {
    for (const session of listSessions(project.encodedName)) {
      sessions.push(toProviderSessionRef("claude", session));
    }
  }

  return syncProviderSessionRefsToStorage({
    provider: "claude",
    phase,
    projectCount: projects.length,
    sessions,
  });
}

export async function syncSessionsToStorage(
  adapter: AgentProviderAdapter,
  phase: "syncing" | "rebuilding" = "syncing",
): Promise<{ projectCount: number; sessionCount: number }> {
  const sessions = await adapter.discoverSessions();
  const projectCount = new Set(sessions.map((session) => session.projectPath)).size;
  return syncProviderSessionRefsToStorage({
    provider: adapter.provider,
    phase,
    projectCount,
    sessions,
  });
}

function syncProviderSessionRefsToStorage({
  provider,
  phase,
  projectCount,
  sessions,
}: {
  provider: ProviderSessionRef["provider"];
  phase: "syncing" | "rebuilding";
  projectCount: number;
  sessions: ProviderSessionRef[];
}): { projectCount: number; sessionCount: number } {
  lastSyncStatus = {
    ...lastSyncStatus,
    phase,
    errorMessage: null,
  };

  try {
    const seenSessionIds: string[] = [];
    const seenProjectPaths = new Set<string>();

    withTransaction(() => {
      for (const session of sessions) {
        const transcriptSourceId = upsertTranscriptSource(session);
        ensureIngestionCheckpoint(transcriptSourceId);
        upsertSession(session, transcriptSourceId);
        ingestTranscriptSource(session, transcriptSourceId);
        deriveAndStoreSessionState(session.id);
        deriveAndStoreTasksForSession(session.id);
        seenSessionIds.push(session.id);
        seenProjectPaths.add(session.projectPath);
      }

      // Run task derivation a second time after every session has been ingested so
      // cross-session attachment can see explicit tasks created later in discovery order.
      for (const sessionId of seenSessionIds) {
        deriveAndStoreTasksForSession(sessionId);
      }

      for (const projectPath of seenProjectPaths) {
        deriveAndStoreWorkstreamsForProject(projectPath);
        deriveAndStoreM6ForProject(projectPath);
        deriveAndStoreHandoffsForProject(projectPath);
      }

      markMissingTranscriptSourcesInactive(provider, seenSessionIds);
    });

    const result = {
      projectCount,
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

function ingestTranscriptSource(ref: ProviderSessionRef, transcriptSourceId: number): void {
  const checkpoint = getIngestionCheckpoint(transcriptSourceId);
  if (!checkpoint) {
    throw new Error(`Missing ingestion checkpoint for transcript source ${transcriptSourceId}`);
  }

  const fileStat = statSync(ref.sourcePath);
  const fileSizeBytes = fileStat.size;
  const parserVersionChanged = checkpoint.parserVersion !== STORAGE_PARSER_VERSION;
  const fileShrank = checkpoint.lastProcessedByteOffset > fileSizeBytes;

  if (parserVersionChanged || fileShrank) {
    resetIngestionCheckpoint(transcriptSourceId);
  }

  const current = getIngestionCheckpoint(transcriptSourceId);
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

  markIngestionCheckpointStatus(transcriptSourceId, "processing");

  try {
    const progress = replaceParsedEvidence({ ref });
    updateIngestionCheckpointProgress(transcriptSourceId, progress, "ready");
  } catch (error) {
    markIngestionCheckpointStatus(
      transcriptSourceId,
      "error",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

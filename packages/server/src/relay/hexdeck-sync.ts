import crypto from "node:crypto";
import { loadRelayConfig } from "./config.js";
import { sendHexdeckIngestBatch } from "./hexdeck-ingest-api.js";
import { buildHexcoreExportPayload } from "../storage/hexcore-export.js";
import { initStorage } from "../storage/db.js";

export interface HexdeckSyncResult {
  hexcoreId: string;
  hexcoreName: string;
  projectCount: number;
  sessionCount: number;
  evidenceCount: number;
  batchIds: string[];
  syncRunId: string;
  chunkCount: number;
}

const DEFAULT_CHUNK_SIZE = 20;

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function syncHexdeckToRelayTarget(hexcoreId: string): Promise<HexdeckSyncResult> {
  const config = loadRelayConfig();
  const target = config.targets.find((entry) => entry.hexcoreId === hexcoreId);
  if (!target) {
    throw new Error(`Relay target not found for hexcore ${hexcoreId}`);
  }
  if (target.projects.length === 0) {
    throw new Error(`Relay target ${target.hexcoreName} has no included projects`);
  }

  await initStorage();
  const payload = buildHexcoreExportPayload(target.projects);
  const syncRunId = crypto.randomUUID();
  const chunks = chunkArray(payload.sessions, DEFAULT_CHUNK_SIZE);
  const batchIds: string[] = [];
  let totalSessionCount = 0;
  let totalEvidenceCount = 0;

  if (chunks.length === 0) {
    const result = await sendHexdeckIngestBatch(target, {
      ...payload,
      checkpoint: {
        ...payload.checkpoint,
        syncRunId,
        chunkIndex: 0,
        totalChunks: 1,
        chunkSize: 0,
      },
      metadata: {
        ...payload.metadata,
        syncRunId,
        chunkIndex: 0,
        totalChunks: 1,
        chunkSize: 0,
        isFinalChunk: true,
      },
      sessions: [],
    });
    batchIds.push(result.batchId);
    totalSessionCount += result.sessionCount;
    totalEvidenceCount += result.evidenceCount;
  } else {
    for (const [index, sessions] of chunks.entries()) {
      const result = await sendHexdeckIngestBatch(target, {
        ...payload,
        checkpoint: {
          ...payload.checkpoint,
          syncRunId,
          chunkIndex: index,
          totalChunks: chunks.length,
          chunkSize: sessions.length,
        },
        metadata: {
          ...payload.metadata,
          syncRunId,
          chunkIndex: index,
          totalChunks: chunks.length,
          chunkSize: sessions.length,
          isFinalChunk: index === chunks.length - 1,
        },
        sessions,
      });
      batchIds.push(result.batchId);
      totalSessionCount += result.sessionCount;
      totalEvidenceCount += result.evidenceCount;
    }
  }

  return {
    hexcoreId: target.hexcoreId,
    hexcoreName: target.hexcoreName,
    projectCount: target.projects.length,
    sessionCount: totalSessionCount,
    evidenceCount: totalEvidenceCount,
    batchIds,
    syncRunId,
    chunkCount: Math.max(chunks.length, 1),
  };
}

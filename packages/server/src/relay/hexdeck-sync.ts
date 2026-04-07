import { loadRelayConfig } from "./config.js";
import { sendHexdeckIngestBatch } from "./hexdeck-ingest-api.js";
import { buildHexcoreExportPayload } from "../storage/hexcore-export.js";

export interface HexdeckSyncResult {
  hexcoreId: string;
  hexcoreName: string;
  projectCount: number;
  sessionCount: number;
  evidenceCount: number;
  batchId: string;
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

  const payload = buildHexcoreExportPayload(target.projects);
  const result = await sendHexdeckIngestBatch(target, payload);

  return {
    hexcoreId: target.hexcoreId,
    hexcoreName: target.hexcoreName,
    projectCount: target.projects.length,
    sessionCount: result.sessionCount,
    evidenceCount: result.evidenceCount,
    batchId: result.batchId,
  };
}

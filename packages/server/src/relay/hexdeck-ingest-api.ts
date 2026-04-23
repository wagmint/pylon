import { deriveHttpBaseFromWs } from "./link.js";
import type { RelayTarget } from "./types.js";
import type { HexcoreExportPayload, HexcoreSyncCursor } from "../storage/hexcore-export.js";
import { classifyRelayResponse } from "./relay-error.js";

interface HexdeckSyncStateResponse {
  success?: boolean;
  data?: {
    syncState?: {
      schemaVersion?: string | null;
      lastAcceptedSourceLastEventAt?: string | null;
      lastAcceptedSessionId?: string | null;
      lastCompletedSyncRunId?: string | null;
      lastCompletedAt?: string | null;
      metadata?: Record<string, unknown>;
    } | null;
  };
  message?: string;
}

export async function fetchHexdeckSyncCursor(target: RelayTarget): Promise<HexcoreSyncCursor | null> {
  const httpBase = deriveHttpBaseFromWs(target.wsUrl);
  const response = await fetch(`${httpBase}/api/hexcores/${target.hexcoreId}/hexdeck/ingest/sync-state`, {
    headers: {
      Authorization: `Bearer ${target.token}`,
    },
  });

  if (!response.ok) {
    throw await classifyRelayResponse(response, "Failed to fetch Hexdeck sync state");
  }

  let body: HexdeckSyncStateResponse | null = null;
  try {
    body = await response.json() as HexdeckSyncStateResponse;
  } catch {
    body = null;
  }

  const syncState = body?.data?.syncState;
  if (!syncState) {
    return null;
  }

  return {
    lastAcceptedSourceLastEventAt: syncState.lastAcceptedSourceLastEventAt ?? null,
    lastAcceptedSessionId: syncState.lastAcceptedSessionId ?? null,
  };
}

export async function sendHexdeckIngestBatch(
  target: RelayTarget,
  payload: HexcoreExportPayload,
): Promise<{ batchId: string; sessionCount: number; evidenceCount: number }> {
  const httpBase = deriveHttpBaseFromWs(target.wsUrl);
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
  const response = await fetch(`${httpBase}/api/hexcores/${target.hexcoreId}/hexdeck/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.token}`,
    },
    body: JSON.stringify({ payloadB64 }),
  });

  if (!response.ok) {
    throw await classifyRelayResponse(response, "Hexdeck ingest failed");
  }

  let body: { message?: string; data?: { batchId: string; sessionCount: number; evidenceCount: number } } | null = null;
  try {
    body = await response.json() as { message?: string; data?: { batchId: string; sessionCount: number; evidenceCount: number } };
  } catch {
    body = null;
  }

  if (!body?.data) {
    throw new Error(`Hexdeck ingest failed (${response.status}): no response body`);
  }

  return body.data;
}

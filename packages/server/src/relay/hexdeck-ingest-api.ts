import { deriveHttpBaseFromWs } from "./link.js";
import type { RelayTarget } from "./types.js";
import type { HexcoreExportPayload, HexcoreSyncCursor } from "../storage/hexcore-export.js";

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

  const rawText = await response.text();
  let body: HexdeckSyncStateResponse | null = null;
  try {
    body = JSON.parse(rawText) as HexdeckSyncStateResponse;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = body?.message || summarizeErrorBody(rawText, response.headers.get("content-type") || "", response.status);
    throw new Error(`Failed to fetch Hexdeck sync state (${response.status}): ${detail}`);
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

  const rawText = await response.text();
  const contentType = response.headers.get("content-type") || "";
  let body: { message?: string; data?: { batchId: string; sessionCount: number; evidenceCount: number } } | null = null;
  try {
    body = JSON.parse(rawText) as { message?: string; data?: { batchId: string; sessionCount: number; evidenceCount: number } };
  } catch {
    body = null;
  }

  if (!response.ok || !body?.data) {
    const detail = body?.message
      || summarizeErrorBody(rawText, contentType, response.status)
      || "no response body";
    throw new Error(`Hexdeck ingest failed (${response.status}): ${detail}`);
  }

  return body.data;
}

function summarizeErrorBody(rawText: string, contentType: string, status: number): string {
  if (!rawText) {
    return `HTTP ${status}`;
  }

  if (contentType.includes("application/json")) {
    return truncate(rawText, 300);
  }

  if (contentType.includes("text/html") || /<html[\s>]/i.test(rawText)) {
    return `HTTP ${status} HTML error response`;
  }

  return truncate(rawText.replace(/\s+/g, " ").trim(), 300);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

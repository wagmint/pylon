import { deriveHttpBaseFromWs } from "./link.js";
import type { RelayTarget } from "./types.js";
import type { HexcoreExportPayload } from "../storage/hexcore-export.js";

export async function sendHexdeckIngestBatch(
  target: RelayTarget,
  payload: HexcoreExportPayload,
): Promise<{ batchId: string; sessionCount: number; evidenceCount: number }> {
  const httpBase = deriveHttpBaseFromWs(target.wsUrl);
  const response = await fetch(`${httpBase}/api/hexcores/${target.hexcoreId}/hexdeck/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.token}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let body: { message?: string; data?: { batchId: string; sessionCount: number; evidenceCount: number } } | null = null;
  try {
    body = JSON.parse(rawText) as { message?: string; data?: { batchId: string; sessionCount: number; evidenceCount: number } };
  } catch {
    body = null;
  }

  if (!response.ok || !body?.data) {
    const detail = body?.message || rawText || "no response body";
    throw new Error(`Hexdeck ingest failed (${response.status}): ${detail}`);
  }

  return body.data;
}

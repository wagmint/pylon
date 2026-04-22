import { deriveHttpBaseFromWs } from "./link.js";
import type { NormalizedIntentEvent } from "./intent-events.js";
import type { RelayTarget } from "./types.js";

export class IntentIngestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export async function sendIntentEvents(target: RelayTarget, events: NormalizedIntentEvent[]): Promise<void> {
  if (events.length === 0) return;

  const httpBase = deriveHttpBaseFromWs(target.wsUrl);
  // Base64-encode events to avoid WAF content inspection blocking code snippets
  const eventsB64 = Buffer.from(JSON.stringify(events)).toString("base64");
  const response = await fetch(`${httpBase}/api/hexcores/${target.hexcoreId}/intent-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.token}`,
    },
    body: JSON.stringify({ eventsB64 }),
  });

  if (!response.ok) {
    let message = `Intent event ingest failed (${response.status})`;
    try {
      const body = await response.json() as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // ignore
    }
    throw new IntentIngestError(message, response.status);
  }
}

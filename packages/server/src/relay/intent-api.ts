import { deriveHttpBaseFromWs } from "./link.js";
import type { NormalizedIntentEvent } from "./intent-events.js";
import type { RelayTarget } from "./types.js";
import { RelayApiError, classifyRelayResponse } from "./relay-error.js";

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
    throw await classifyRelayResponse(response, "Intent event ingest failed");
  }
}


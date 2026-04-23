export class RelayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Inspect a non-ok HTTP response and return a typed RelayApiError.
 * Parses Retry-After header (seconds) and attempts to extract a message from JSON body.
 */
export async function classifyRelayResponse(response: Response, fallbackMessage: string): Promise<RelayApiError> {
  let message = `${fallbackMessage} (${response.status})`;
  try {
    const body = await response.json() as { message?: string };
    if (body?.message) message = body.message;
  } catch {
    // ignore
  }

  let retryAfterMs: number | null = null;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      retryAfterMs = seconds * 1000;
    } else {
      // Try HTTP-date format (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const deltaMs = date.getTime() - Date.now();
        if (deltaMs > 0) {
          retryAfterMs = deltaMs;
        }
      }
    }
  }

  return new RelayApiError(message, response.status, retryAfterMs);
}

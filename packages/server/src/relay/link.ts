export interface ParsedConnectLink {
  hexcoreId: string;
  hexcoreName: string;
  wsUrl: string;
  /** Legacy one-time connect code (c= param) */
  connectCode?: string;
  /** New reusable invite token (t= param) */
  inviteToken?: string;
}

export interface ExchangedRelayCredentials {
  hexcoreId: string;
  hexcoreName: string;
  wsUrl: string;
  token: string;
  relayClientId: string;
  relayClientSecret: string;
}

/**
 * Parse a hexcore+wss:// connect link into its components.
 * Supports both legacy c= (connect code) and new t= (invite token) formats.
 * Throws on invalid format or missing required parameters.
 */
export function parseConnectLink(link: string): ParsedConnectLink {
  let url: URL;
  try {
    const normalized = link.replace(/^hexcore\+/, "");
    url = new URL(normalized);
  } catch {
    throw new Error("Invalid connect link format. Expected: hexcore+wss://<host>/ws?p=<hexcoreId>&...");
  }

  const hexcoreId = url.searchParams.get("p");
  const connectCode = url.searchParams.get("c") || undefined;
  const inviteToken = url.searchParams.get("t") || undefined;
  const hexcoreName = url.searchParams.get("n") || "Unnamed Relay";

  if (!hexcoreId) {
    throw new Error("Connect link missing required parameter (p).");
  }

  if (!connectCode && !inviteToken) {
    throw new Error("Connect link missing auth parameter (c or t).");
  }

  const wsUrl = `${url.protocol}//${url.host}${url.pathname}`;

  return { hexcoreId, hexcoreName, wsUrl, connectCode, inviteToken };
}

interface ConnectExchangeApiResponse {
  success: boolean;
  message: string;
  data?: {
    accessToken?: string;
    relayClientId?: string;
    relayClientSecret?: string;
  };
}

export function deriveHttpBaseFromWs(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/ws\/?$/, "");
}

/**
 * Exchange a one-time connect code for relay client credentials.
 * Only works with legacy c= connect codes.
 */
export async function exchangeConnectLink(parsed: ParsedConnectLink): Promise<ExchangedRelayCredentials> {
  if (!parsed.connectCode) {
    throw new Error("Cannot exchange: no connect code present");
  }

  const httpBase = deriveHttpBaseFromWs(parsed.wsUrl);

  const response = await fetch(`${httpBase}/api/auth/connect-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hexcoreId: parsed.hexcoreId,
      code: parsed.connectCode,
    }),
  });

  let body: ConnectExchangeApiResponse | null = null;
  try {
    body = (await response.json()) as ConnectExchangeApiResponse;
  } catch {
    body = null;
  }

  if (!response.ok || !body?.success) {
    const message = body?.message || `Connect code exchange failed (${response.status})`;
    throw new Error(message);
  }

  const token = body.data?.accessToken;
  const relayClientId = body.data?.relayClientId;
  const relayClientSecret = body.data?.relayClientSecret;
  if (!token || !relayClientId || !relayClientSecret) {
    throw new Error("Connect exchange returned invalid credentials.");
  }

  return {
    hexcoreId: parsed.hexcoreId,
    hexcoreName: parsed.hexcoreName,
    wsUrl: parsed.wsUrl,
    token,
    relayClientId,
    relayClientSecret,
  };
}

interface CreateClaimApiResponse {
  success: boolean;
  message: string;
  data?: {
    claimId: string;
    claimSecret: string;
    hexcoreName: string;
    hexcoreId: string;
    expiresAt: string;
  };
}

/**
 * Create a relay claim for the invite token flow.
 * Returns claim info that the dashboard UI uses for onboarding.
 */
export async function createRelayClaim(parsed: ParsedConnectLink): Promise<{
  claimId: string;
  claimSecret: string;
  hexcoreName: string;
  hexcoreId: string;
  wsUrl: string;
  inviteToken: string;
  joinUrl: string;
}> {
  if (!parsed.inviteToken) {
    throw new Error("Cannot create claim: no invite token present");
  }

  const httpBase = deriveHttpBaseFromWs(parsed.wsUrl);

  const response = await fetch(`${httpBase}/api/relay-claims`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hexcoreId: parsed.hexcoreId,
      inviteToken: parsed.inviteToken,
    }),
  });

  let body: CreateClaimApiResponse | null = null;
  try {
    body = (await response.json()) as CreateClaimApiResponse;
  } catch {
    body = null;
  }

  if (!response.ok || !body?.success || !body.data) {
    const message = body?.message || `Create relay claim failed (${response.status})`;
    throw new Error(message);
  }

  // Build the web join URL: https://hexcore.app/connect?claim=<claimId>&p=<hexcoreId>&t=<inviteToken>
  const webBase = httpBase.replace(/:\d+$/, ":3000"); // dev fallback
  const appBase = httpBase.includes("hexcore.app")
    ? httpBase.replace(/^(https?:\/\/)relay\./, "$1")
    : webBase;
  const joinParams = new URLSearchParams({
    claim: body.data.claimId,
    p: body.data.hexcoreId,
    t: parsed.inviteToken,
  });
  const joinUrl = `${appBase}/connect?${joinParams.toString()}`;

  return {
    claimId: body.data.claimId,
    claimSecret: body.data.claimSecret,
    hexcoreName: body.data.hexcoreName,
    hexcoreId: body.data.hexcoreId,
    wsUrl: parsed.wsUrl,
    inviteToken: parsed.inviteToken,
    joinUrl,
  };
}

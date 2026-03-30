import { open } from "@tauri-apps/plugin-shell";

export const API_BASE = "http://localhost:7433";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JoinParams {
  inviteToken: string;
  hexcoreId: string;
  hexcoreName: string;
  wsUrl?: string;
  memberCount?: number;
}

export type JoinPhase =
  | "waiting-for-server"
  | "creating-claim"
  | "browser-auth"
  | "polling"
  | "done";

export interface JoinResult {
  ok: boolean;
  hexcoreName: string;
  hexcoreId?: string;
  wsUrl?: string;
  error?: string;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export async function waitForServer(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function parseJoinUrl(
  urlStr: string
): { inviteToken: string; hexcoreId: string; hexcoreName: string; wsUrl?: string } | null {
  try {
    const url = new URL(urlStr);
    // hexdeck://join?... → hostname is "join", pathname is empty
    const action = url.hostname || url.pathname.replace(/^\//, "");
    if (action !== "join") return null;
    const inviteToken = url.searchParams.get("t");
    const hexcoreId = url.searchParams.get("p");
    const hexcoreName = url.searchParams.get("n") || "Unnamed Team";
    const wsUrl = url.searchParams.get("w") || undefined;
    if (!inviteToken || !hexcoreId) return null;
    return { inviteToken, hexcoreId, hexcoreName, wsUrl };
  } catch {
    return null;
  }
}

export async function pollClaimStatus(
  claimId: string,
  timeoutMs = 300000,
  signal?: AbortSignal
): Promise<{ status: string; hexcoreId?: string; hexcoreName?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return { status: "aborted" };
    try {
      const res = await fetch(`${API_BASE}/api/relay/claim-status/${claimId}`, { signal });
      if (!res.ok) {
        if (res.status === 404) return { status: "error" };
      } else {
        const body = (await res.json()) as { status: string; hexcoreId?: string; hexcoreName?: string };
        if (body.status === "completed") return body;
      }
    } catch (err: unknown) {
      if (signal?.aborted) return { status: "aborted" };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "timeout" };
}

// ─── Resolve invite input (multi-format) ──────────────────────────────────────

/**
 * Parses multiple invite formats into JoinParams:
 *  1. hexdeck://join?t=...&p=...  → parse directly
 *  2. hexcore+wss://...           → parse URL params
 *  3. https://hexcore.app/invite/TOKEN → call /api/relay/invite-info
 *  4. Raw token (8+ alphanumeric) → call /api/relay/invite-info
 */
export async function resolveInviteInput(
  input: string,
  signal?: AbortSignal
): Promise<JoinParams> {
  const trimmed = input.trim();

  // 1. hexdeck:// deep link
  if (trimmed.startsWith("hexdeck://")) {
    const parsed = parseJoinUrl(trimmed);
    if (parsed) return parsed;
    throw new Error("Invalid deep link format");
  }

  // 2. hexcore+wss:// legacy link
  if (trimmed.startsWith("hexcore+wss://") || trimmed.startsWith("hexcore+ws://")) {
    const parsed = parseJoinUrl(trimmed);
    if (parsed) return parsed;
    throw new Error("Invalid legacy link format");
  }

  // 3. https://hexcore.app/invite/TOKEN or http://localhost:3000/invite/TOKEN
  const webMatch = trimmed.match(/^https?:\/\/[^/]+\/invite\/([A-Za-z0-9_-]+)/);
  if (webMatch) {
    // Derive relay wsUrl for localhost dev
    let wsUrl: string | undefined;
    try {
      const u = new URL(trimmed);
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        wsUrl = `ws://${u.hostname}:3010/ws`;
      }
    } catch {}
    return fetchInviteInfo(webMatch[1], signal, wsUrl);
  }

  // 4. Raw token (8+ alphanumeric chars)
  if (/^[A-Za-z0-9_-]{8,}$/.test(trimmed)) {
    return fetchInviteInfo(trimmed, signal);
  }

  throw new Error("Unrecognized invite format");
}

async function fetchInviteInfo(token: string, signal?: AbortSignal, wsUrl?: string): Promise<JoinParams> {
  const qs = new URLSearchParams({ token });
  if (wsUrl) qs.set("wsUrl", wsUrl);
  const res = await fetch(
    `${API_BASE}/api/relay/invite-info?${qs.toString()}`,
    { signal }
  );

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Invalid or expired invite token");
  }

  const data = (await res.json()) as {
    valid: boolean;
    hexcoreId?: string;
    hexcoreName?: string;
    memberCount?: number;
    wsUrl?: string;
  };

  if (!data.valid || !data.hexcoreId) {
    throw new Error("Invalid or expired invite token");
  }

  return {
    inviteToken: token,
    hexcoreId: data.hexcoreId,
    hexcoreName: data.hexcoreName || "Unnamed Team",
    wsUrl: data.wsUrl,
    memberCount: data.memberCount,
  };
}

// ─── Execute join flow ────────────────────────────────────────────────────────

export async function executeJoinFlow(
  params: JoinParams,
  onPhaseChange?: (phase: JoinPhase) => void,
  signal?: AbortSignal
): Promise<JoinResult> {
  try {
    // 1. Wait for server
    onPhaseChange?.("waiting-for-server");
    const serverReady = await waitForServer();
    if (!serverReady) {
      return { ok: false, hexcoreName: params.hexcoreName, error: "Server not reachable. Is Hexdeck running?" };
    }
    if (signal?.aborted) return { ok: false, hexcoreName: params.hexcoreName, error: "Cancelled" };

    // 2. Create claim
    onPhaseChange?.("creating-claim");
    const res = await fetch(`${API_BASE}/api/relay/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteToken: params.inviteToken,
        hexcoreId: params.hexcoreId,
        hexcoreName: params.hexcoreName,
        wsUrl: params.wsUrl,
      }),
      signal,
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, hexcoreName: params.hexcoreName, error: body.error || "Failed to create claim" };
    }

    const claim = (await res.json()) as {
      claimId: string;
      hexcoreName: string;
      hexcoreId: string;
      joinUrl: string;
    };

    // 3. Open browser
    onPhaseChange?.("browser-auth");
    await open(claim.joinUrl);

    // 4. Poll
    onPhaseChange?.("polling");
    const result = await pollClaimStatus(claim.claimId, 300000, signal);

    if (result.status === "completed") {
      onPhaseChange?.("done");
      return {
        ok: true,
        hexcoreName: result.hexcoreName || claim.hexcoreName,
        hexcoreId: result.hexcoreId || claim.hexcoreId,
        wsUrl: params.wsUrl,
      };
    } else if (result.status === "timeout") {
      return { ok: false, hexcoreName: claim.hexcoreName, error: "Join timed out. Please try again." };
    } else if (result.status === "aborted") {
      return { ok: false, hexcoreName: params.hexcoreName, error: "Cancelled" };
    } else {
      return { ok: false, hexcoreName: claim.hexcoreName, error: "Claim expired or failed." };
    }
  } catch (err) {
    if (signal?.aborted) return { ok: false, hexcoreName: params.hexcoreName, error: "Cancelled" };
    const message = err instanceof Error ? err.message : "Unexpected error";
    return { ok: false, hexcoreName: params.hexcoreName, error: message };
  }
}

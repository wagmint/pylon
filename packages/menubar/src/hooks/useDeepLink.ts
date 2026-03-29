import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { open } from "@tauri-apps/plugin-shell";
import { getAllWindows } from "@tauri-apps/api/window";

export interface JoinToast {
  type: "success" | "error";
  hexcoreName: string;
  hexcoreId?: string;
  wsUrl?: string;
  message: string;
}

const API_BASE = "http://localhost:7433";

async function waitForServer(timeoutMs = 15000): Promise<boolean> {
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

function parseJoinUrl(urlStr: string): { inviteToken: string; hexcoreId: string; hexcoreName: string; wsUrl?: string } | null {
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

async function pollClaimStatus(claimId: string, timeoutMs = 300000): Promise<{ status: string; hexcoreId?: string; hexcoreName?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API_BASE}/api/relay/claim-status/${claimId}`);
      if (!res.ok) {
        if (res.status === 404) {
          return { status: "error" };
        }
        // Transient error, keep polling
      } else {
        const body = await res.json() as { status: string; hexcoreId?: string; hexcoreName?: string };
        if (body.status === "completed") {
          return body;
        }
      }
    } catch {
      // Network error, keep polling
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "timeout" };
}

async function showMainWindow() {
  try {
    const allWindows = await getAllWindows();
    const mainWin = allWindows.find(w => w.label === "main");
    if (mainWin) {
      await mainWin.show();
      await mainWin.setFocus();
    }
  } catch {
    // Not critical
  }
}

export function useDeepLink(enabled = true): { toast: JoinToast | null; clearToast: () => void } {
  const [toast, setToast] = useState<JoinToast | null>(null);
  const processingRef = useRef(false);
  const lastUrlRef = useRef<string>("");

  const clearToast = useCallback(() => setToast(null), []);

  // Set toast and show the main window together so there's no empty-window flash
  const showToast = useCallback(async (t: JoinToast) => {
    setToast(t);
    await showMainWindow();
  }, []);

  const handleDeepLink = useCallback(async (urls: string[]) => {
    const url = urls[0];
    if (!url || processingRef.current) return;
    if (url === lastUrlRef.current) return;
    lastUrlRef.current = url;

    const params = parseJoinUrl(url);
    if (!params) return;

    processingRef.current = true;

    try {
      // Wait for server to be ready (cold start)
      const serverReady = await waitForServer();
      if (!serverReady) {
        await showToast({ type: "error", hexcoreName: params.hexcoreName, message: "Server not reachable. Is Hexdeck running?" });
        return;
      }

      // Create relay claim
      const res = await fetch(`${API_BASE}/api/relay/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviteToken: params.inviteToken,
          hexcoreId: params.hexcoreId,
          hexcoreName: params.hexcoreName,
          wsUrl: params.wsUrl,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        await showToast({ type: "error", hexcoreName: params.hexcoreName, message: body.error || "Failed to create claim" });
        return;
      }

      const claim = await res.json() as { claimId: string; hexcoreName: string; hexcoreId: string; joinUrl: string };

      // Open browser for auth
      await open(claim.joinUrl);

      // Poll until claim is completed
      const result = await pollClaimStatus(claim.claimId);

      if (result.status === "completed") {
        await showToast({
          type: "success",
          hexcoreName: result.hexcoreName || claim.hexcoreName,
          hexcoreId: result.hexcoreId || claim.hexcoreId,
          wsUrl: params.wsUrl,
          message: `Connected to ${result.hexcoreName || claim.hexcoreName}.`,
        });
      } else if (result.status === "timeout") {
        await showToast({ type: "error", hexcoreName: claim.hexcoreName, message: "Join timed out. Please try again." });
      } else {
        await showToast({ type: "error", hexcoreName: claim.hexcoreName, message: "Claim expired or failed." });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error";
      await showToast({ type: "error", hexcoreName: params.hexcoreName, message });
    } finally {
      processingRef.current = false;
      lastUrlRef.current = ""; // Allow retrying the same link
    }
  }, [showToast]);

  useEffect(() => {
    if (!enabled) return;

    // Cold start: check if app was opened via deep link
    getCurrent().then((urls) => {
      if (urls && urls.length > 0) {
        handleDeepLink(urls);
      }
    }).catch(() => {});

    // Hot start: listen for new deep link events
    let unlisten: (() => void) | undefined;
    onOpenUrl((urls) => {
      handleDeepLink(urls);
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {});

    return () => unlisten?.();
  }, [enabled, handleDeepLink]);

  return { toast, clearToast };
}

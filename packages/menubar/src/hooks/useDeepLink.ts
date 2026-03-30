import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getAllWindows } from "@tauri-apps/api/window";
import { parseJoinUrl, executeJoinFlow } from "../lib/join";

export interface JoinToast {
  type: "success" | "error";
  hexcoreName: string;
  hexcoreId?: string;
  wsUrl?: string;
  message: string;
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

    const result = await executeJoinFlow(params);

    if (result.ok) {
      await showToast({
        type: "success",
        hexcoreName: result.hexcoreName,
        hexcoreId: result.hexcoreId,
        wsUrl: result.wsUrl,
        message: `Connected to ${result.hexcoreName}.`,
      });
    } else {
      await showToast({
        type: "error",
        hexcoreName: result.hexcoreName,
        message: result.error || "Failed to join",
      });
    }

    processingRef.current = false;
    lastUrlRef.current = ""; // Allow retrying the same link
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

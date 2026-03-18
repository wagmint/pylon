import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DashboardState } from "../lib/types";

const SSE_URL = "http://localhost:7433/api/dashboard/stream";
const INITIAL_RETRY_MS = 2000;
const MAX_RETRY_MS = 10000;
const STALE_THRESHOLD_MS = 12_000; // 12s = missed 2+ heartbeats (server sends every 5s)

interface UseHexcoreSSEResult {
  state: DashboardState | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
}

export function useHexcoreSSE(): UseHexcoreSSEResult {
  const [state, setState] = useState<DashboardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const hasReceivedData = useRef(false);
  const retryDelay = useRef(INITIAL_RETRY_MS);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);
  const lastMessageTime = useRef(0);

  /** Close current connection and reconnect immediately (bypass backoff). */
  const reconnectNow = useCallback(() => {
    if (!mountedRef.current) return;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    retryDelay.current = INITIAL_RETRY_MS;
    // Use setTimeout(0) to avoid calling connect synchronously inside an event handler
    setTimeout(() => {
      if (mountedRef.current) connect();
    }, 0);
  }, []); // connect added below via mutual ref

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const es = new EventSource(SSE_URL);
    esRef.current = es;

    es.addEventListener("state", (e) => {
      try {
        lastMessageTime.current = Date.now();
        const data: DashboardState = JSON.parse(e.data);
        setState(data);
        setError(null);
        if (!hasReceivedData.current) {
          hasReceivedData.current = true;
          setLoading(false);
        }
        // Reset retry delay on successful data
        retryDelay.current = INITIAL_RETRY_MS;
      } catch {
        setError("Failed to parse dashboard state");
      }
    });

    // Listen for heartbeat events — just update timestamp, no state processing
    es.addEventListener("hb", () => {
      lastMessageTime.current = Date.now();
    });

    es.onopen = () => {
      setConnected(true);
      setError(null);
      lastMessageTime.current = Date.now();
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setConnected(false);

      if (!hasReceivedData.current) {
        setError("Starting server...");
        setLoading(false);
      }

      // Ask the backend to ensure the server is running (Rust side rate-limits spawns)
      invoke("ensure_server").catch(() => {});

      // Schedule reconnect with exponential backoff
      if (mountedRef.current) {
        const delay = retryDelay.current;
        retryDelay.current = Math.min(delay * 1.5, MAX_RETRY_MS);
        retryTimer.current = setTimeout(connect, delay);
      }
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    // Staleness check: every 5s, if no message in 12s, force reconnect
    const stalenessInterval = setInterval(() => {
      if (
        lastMessageTime.current > 0 &&
        Date.now() - lastMessageTime.current > STALE_THRESHOLD_MS
      ) {
        reconnectNow();
      }
    }, 5000);

    // Visibility listener: catches laptop sleep/wake (lid open fires visibilitychange)
    const onVisibility = () => {
      if (!document.hidden && lastMessageTime.current > 0) {
        if (Date.now() - lastMessageTime.current > STALE_THRESHOLD_MS) {
          reconnectNow();
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Online listener: catches network drops/reconnects
    const onOnline = () => {
      reconnectNow();
    };
    window.addEventListener("online", onOnline);

    return () => {
      mountedRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      clearInterval(stalenessInterval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [connect, reconnectNow]);

  return { state, loading, error, connected };
}

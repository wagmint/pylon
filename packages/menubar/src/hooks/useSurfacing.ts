import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type {
  SurfacingState,
  SurfacedWorkstream,
  SurfacedUnassigned,
  WorkstreamStatusAction,
  StatusActionState,
} from "../lib/surfacing-types";

const BASE_URL = "http://localhost:7433";
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;

export interface FlatWorkstream extends SurfacedWorkstream {
  hexcoreId: string;
}

export interface FlatUnassigned extends SurfacedUnassigned {
  hexcoreId: string;
}

interface UseSurfacingResult {
  allWorkstreams: FlatWorkstream[];
  allUnassigned: FlatUnassigned[];
  reportStatus: (hexcoreId: string, workstreamId: string, action: WorkstreamStatusAction) => void;
  statusActions: Map<string, StatusActionState>;
}

export function useSurfacing(
  surfacing: SurfacingState | null,
  _connected: boolean,
): UseSurfacingResult {
  const [statusActions, setStatusActions] = useState<Map<string, StatusActionState>>(new Map());
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedRef = useRef(true);

  // Clear resolved actions when surfacing updates (SSE push)
  useEffect(() => {
    if (!surfacing) return;
    setStatusActions((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, state] of next) {
        if (state.status === "resolved") {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [surfacing]);

  // Cleanup poll timers on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of pollTimers.current.values()) {
        clearTimeout(timer);
      }
      pollTimers.current.clear();
    };
  }, []);

  const allWorkstreams = useMemo<FlatWorkstream[]>(() => {
    if (!surfacing) return [];
    return surfacing.hexcores.flatMap((hc) =>
      hc.workstreams.map((ws) => ({ ...ws, hexcoreId: hc.hexcoreId })),
    );
  }, [surfacing]);

  const allUnassigned = useMemo<FlatUnassigned[]>(() => {
    if (!surfacing) return [];
    return surfacing.hexcores.flatMap((hc) =>
      hc.unassigned.map((u) => ({ ...u, hexcoreId: hc.hexcoreId })),
    );
  }, [surfacing]);

  const pollStatusResult = useCallback(
    (hexcoreId: string, workstreamId: string, pollCount: number) => {
      if (!mountedRef.current || pollCount >= MAX_POLLS) {
        // Max polls reached — set error
        setStatusActions((prev) => {
          const next = new Map(prev);
          next.set(workstreamId, {
            status: "error",
            action: prev.get(workstreamId)?.action ?? "done",
            error: "Timed out waiting for response",
          });
          return next;
        });
        return;
      }

      const timer = setTimeout(async () => {
        if (!mountedRef.current) return;
        pollTimers.current.delete(workstreamId);

        try {
          const res = await fetch(
            `${BASE_URL}/api/surfaced-workstreams/${workstreamId}/status-result?hexcoreId=${hexcoreId}`,
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const data = await res.json() as {
            pending: boolean;
            result?: { ok: boolean; reason?: string };
          };

          if (!mountedRef.current) return;

          if (data.pending) {
            pollStatusResult(hexcoreId, workstreamId, pollCount + 1);
            return;
          }

          if (data.result?.ok) {
            setStatusActions((prev) => {
              const next = new Map(prev);
              next.set(workstreamId, {
                status: "resolved",
                action: prev.get(workstreamId)?.action ?? "done",
              });
              return next;
            });
          } else {
            setStatusActions((prev) => {
              const next = new Map(prev);
              next.set(workstreamId, {
                status: "error",
                action: prev.get(workstreamId)?.action ?? "done",
                error: data.result?.reason ?? "Action failed",
              });
              return next;
            });
          }
        } catch {
          if (!mountedRef.current) return;
          setStatusActions((prev) => {
            const next = new Map(prev);
            next.set(workstreamId, {
              status: "error",
              action: prev.get(workstreamId)?.action ?? "done",
              error: "Failed to check status",
            });
            return next;
          });
        }
      }, POLL_INTERVAL_MS);

      pollTimers.current.set(workstreamId, timer);
    },
    [],
  );

  const reportStatus = useCallback(
    async (hexcoreId: string, workstreamId: string, action: WorkstreamStatusAction) => {
      // Clear any existing poll for this workstream
      const existing = pollTimers.current.get(workstreamId);
      if (existing) {
        clearTimeout(existing);
        pollTimers.current.delete(workstreamId);
      }

      setStatusActions((prev) => {
        const next = new Map(prev);
        next.set(workstreamId, { status: "pending", action });
        return next;
      });

      try {
        const res = await fetch(
          `${BASE_URL}/api/surfaced-workstreams/${workstreamId}/status`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hexcoreId, status: action }),
          },
        );

        if (!res.ok) {
          const body = await res.json().catch(() => ({ reason: `HTTP ${res.status}` })) as { reason?: string };
          throw new Error(body.reason ?? `HTTP ${res.status}`);
        }

        // Start polling for result
        pollStatusResult(hexcoreId, workstreamId, 0);
      } catch (err) {
        if (!mountedRef.current) return;
        setStatusActions((prev) => {
          const next = new Map(prev);
          next.set(workstreamId, {
            status: "error",
            action,
            error: err instanceof Error ? err.message : "Request failed",
          });
          return next;
        });
      }
    },
    [pollStatusResult],
  );

  return { allWorkstreams, allUnassigned, reportStatus, statusActions };
}

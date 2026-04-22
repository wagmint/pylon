import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import type { DashboardState } from "../lib/types";
import type { HexcoreAlert, TraySeverity } from "../lib/alerts";
import type { StatusActionState, WorkstreamStatusAction } from "../lib/surfacing-types";
import type { FlatWorkstream, FlatUnassigned } from "../hooks/useSurfacing";
import type { JoinToast as JoinToastType } from "../hooks/useDeepLink";
import { StatusHeader } from "./StatusHeader";
import { AlertList } from "./AlertList";
import { MeSection } from "./MeSection";
import { AgentList } from "./AgentList";
import { JoinToast } from "./JoinToast";

interface MenuBarAppProps {
  state: DashboardState | null;
  alerts: HexcoreAlert[];
  severity: TraySeverity;
  connected: boolean;
  loading: boolean;
  error: string | null;
  joinToast: JoinToastType | null;
  clearJoinToast: () => void;
  allWorkstreams: FlatWorkstream[];
  allUnassigned: FlatUnassigned[];
  reportStatus: (hexcoreId: string, workstreamId: string, action: WorkstreamStatusAction) => void;
  statusActions: Map<string, StatusActionState>;
}

export function MenuBarApp({
  state,
  alerts,
  severity,
  connected,
  loading,
  error,
  joinToast,
  clearJoinToast,
  allWorkstreams,
  allUnassigned,
  reportStatus,
  statusActions,
}: MenuBarAppProps) {
  const agentCount = state?.summary.activeAgents ?? 0;
  const agents = state?.agents ?? [];

  // Auto-dismiss join toast after 15 seconds
  useEffect(() => {
    if (!joinToast) return;
    const timer = setTimeout(clearJoinToast, 15000);
    return () => clearTimeout(timer);
  }, [joinToast, clearJoinToast]);

  const closeWindow = () => {
    getCurrentWindow().hide();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeWindow();
      }
      if (e.key === "Enter") {
        const blocked = agents.find((a) => a.status === "blocked");
        if (blocked) {
          window.dispatchEvent(
            new CustomEvent("hexdeck:decide", {
              detail: { sessionId: blocked.sessionId, action: "approve" },
            }),
          );
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [agents]);

  return (
    <div className="flex flex-col h-screen bg-dash-bg rounded-xl overflow-hidden shadow-lg">
      <StatusHeader
        severity={severity}
        agentCount={agentCount}
        connected={connected}
        onClose={closeWindow}
      />

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="px-4 py-6 text-center">
            <p className="text-xs text-dash-text-muted">Connecting...</p>
          </div>
        )}

        {!loading && error && !state && (
          <div className="px-4 py-6 text-center">
            <p className="text-xs text-dash-red">{error}</p>
            <p className="text-[10px] text-dash-text-muted mt-1">
              Is the Hexdeck server running?
            </p>
          </div>
        )}

        {joinToast && (
          <JoinToast toast={joinToast} onDismiss={clearJoinToast} />
        )}

        {!loading && state && (
          <>
            <AlertList alerts={alerts} />
            {alerts.length > 0 && (allWorkstreams.length > 0 || allUnassigned.length > 0) && (
              <div className="border-t border-dash-border" />
            )}
            <MeSection
              allWorkstreams={allWorkstreams}
              allUnassigned={allUnassigned}
              statusActions={statusActions}
              onReport={reportStatus}
            />
            {(allWorkstreams.length > 0 || allUnassigned.length > 0 || alerts.length > 0) && agents.length > 0 && (
              <div className="border-t border-dash-border" />
            )}
            <AgentList agents={agents} />
          </>
        )}
      </div>

      <div className="border-t border-dash-border px-3 py-2">
        <button
          onClick={() => open("http://localhost:7433")}
          className="w-full text-xs text-dash-blue hover:text-dash-text transition-colors py-1.5 rounded-md hover:bg-dash-surface-2"
        >
          Open Dashboard
        </button>
      </div>
    </div>
  );
}

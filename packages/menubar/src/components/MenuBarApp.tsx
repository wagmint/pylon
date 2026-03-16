import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import type { Collision, DashboardState } from "../lib/types";
import type { HexcoreAlert, TraySeverity } from "../lib/alerts";
import { StatusHeader } from "./StatusHeader";
import { AlertList } from "./AlertList";
import { AgentList } from "./AgentList";

interface MenuBarAppProps {
  state: DashboardState | null;
  alerts: HexcoreAlert[];
  severity: TraySeverity;
  connected: boolean;
  loading: boolean;
  error: string | null;
}

export function MenuBarApp({
  state,
  alerts,
  severity,
  connected,
  loading,
  error,
}: MenuBarAppProps) {
  const agentCount = state?.summary.activeAgents ?? 0;
  const agents = state?.agents ?? [];
  const collisions: Collision[] = state?.collisions ?? [];
  const [floatAcrossSpaces, setFloatAcrossSpaces] = useState(false);

  const closeWindow = () => {
    getCurrentWindow().hide();
  };

  useEffect(() => {
    invoke<boolean>("load_float_across_spaces").then(setFloatAcrossSpaces);
  }, []);

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

        {!loading && state && (
          <>
            <AlertList alerts={alerts} />
            {alerts.length > 0 && agents.length > 0 && (
              <div className="border-t border-dash-border" />
            )}
            <AgentList agents={agents} collisions={collisions} />
          </>
        )}
      </div>

      <div className="border-t border-dash-border px-3 py-2 flex flex-col gap-1">
        <button
          onClick={() => {
            const next = !floatAcrossSpaces;
            setFloatAcrossSpaces(next);
            invoke("save_float_across_spaces", { enabled: next });
          }}
          className="w-full flex items-center justify-between text-xs text-dash-text-muted hover:text-dash-text transition-colors px-1 py-1 rounded-md hover:bg-dash-surface-2"
        >
          <span>Float Across Spaces</span>
          <span className={`w-7 h-4 rounded-full transition-colors flex-shrink-0 ${floatAcrossSpaces ? "bg-dash-blue" : "bg-dash-surface-2"}`}>
            <span className={`block w-3 h-3 bg-white rounded-full mt-0.5 transition-transform ${floatAcrossSpaces ? "translate-x-3.5" : "translate-x-0.5"}`} />
          </span>
        </button>
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

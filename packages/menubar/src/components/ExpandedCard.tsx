import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import type { TraySeverity, HexcoreAlert } from "../lib/alerts";
import type { DashboardState } from "../lib/types";
import { AlertList } from "./AlertList";
import { AgentList } from "./AgentList";
import { GlowHex } from "./GlowHex";
import { ColorLegendPopover } from "./ColorLegendPopover";

interface ExpandedCardProps {
  severity: TraySeverity;
  state: DashboardState | null;
  alerts: HexcoreAlert[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  onClose?: () => void;
}

export function ExpandedCard({
  severity,
  state,
  alerts,
  connected,
  loading,
  error,
  onClose,
}: ExpandedCardProps) {
  const agentCount = state?.summary.activeAgents ?? 0;
  const agents = state?.agents ?? [];

  return (
    <div className="w-[320px] h-[400px] flex flex-col bg-dash-bg border border-dash-border rounded-xl overflow-hidden animate-fade-in">
      {/* Header — drag region */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-dash-border"
        onMouseDown={(e) => { if (e.button === 0) getCurrentWindow().startDragging(); }}
      >
        <div className="flex items-center gap-2.5">
          <GlowHex severity={severity} size={4} />
          <span className="text-sm font-semibold text-dash-text">Hexdeck</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-dash-text-dim">
            {agentCount} agent{agentCount !== 1 ? "s" : ""}
          </span>
          <ColorLegendPopover />
          {onClose && (
            <button
              onClick={onClose}
              className="text-dash-text-muted hover:text-dash-text transition-colors text-sm leading-none w-5 h-5 rounded hover:bg-dash-surface-2"
              aria-label="Close"
              title="Close (Esc)"
            >
              ×
            </button>
          )}
          {!connected && (
            <span className="text-[10px] text-dash-red font-medium">
              disconnected
            </span>
          )}
        </div>
      </div>

      {/* Body */}
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
            <AgentList agents={agents} />
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-dash-border px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => open("http://localhost:7433")}
          className="flex-1 text-xs text-dash-blue hover:text-dash-text transition-colors py-1.5 rounded-md hover:bg-dash-surface-2"
        >
          Open Dashboard
        </button>
        <button
          onClick={() => invoke("quit_app")}
          className="text-xs text-dash-text-muted hover:text-dash-red transition-colors py-1.5 px-3 rounded-md hover:bg-dash-surface-2"
        >
          Quit
        </button>
      </div>
    </div>
  );
}

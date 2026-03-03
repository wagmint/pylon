import type { TraySeverity } from "../lib/alerts";
import type { Agent, AgentStatus, DashboardState } from "../lib/types";
import { GlowHex } from "./GlowHex";

const dotColor: Record<AgentStatus, string> = {
  idle: "bg-dash-text-muted",
  busy: "bg-dash-green",
  warning: "bg-dash-green",
  conflict: "bg-dash-green",
  blocked: "bg-dash-blue",
};

const stateLabel: Record<AgentStatus, string> = {
  idle: "Idle",
  busy: "Running",
  warning: "Warning",
  conflict: "Conflict",
  blocked: "Waiting",
};

interface SummaryPillProps {
  severity: TraySeverity;
  state: DashboardState | null;
  connected: boolean;
}

export function SummaryPill({ severity, state, connected }: SummaryPillProps) {
  const agents: Agent[] = state?.agents.filter((a) => a.isActive) ?? [];

  if (agents.length === 0 && connected) {
    return (
      <div className="w-[200px] flex items-center gap-3 px-3 py-2.5 bg-dash-bg border border-dash-border rounded-2xl cursor-pointer animate-fade-in">
        <GlowHex severity={severity} size={5} />
        <span className="text-[11px] text-dash-text-muted">No active agents</span>
      </div>
    );
  }

  return (
    <div className="w-[200px] flex items-start gap-3 px-3 py-2.5 bg-dash-bg border border-dash-border rounded-2xl cursor-pointer animate-fade-in">
      <GlowHex severity={severity} size={5} className="mt-0.5" />
      <div className="flex flex-col gap-1 min-w-0">
        {!connected && (
          <span className="text-[10px] text-dash-red">offline</span>
        )}
        {agents.map((agent) => (
          <div key={agent.sessionId} className="flex items-center gap-1.5">
            <div
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor[agent.status]} ${
                agent.status === "busy" ? "animate-dash-pulse" : agent.status === "blocked" ? "animate-dash-breathe" : ""
              }`}
            />
            <span className="text-[11px] text-dash-text truncate">{agent.label}</span>
            <span className="text-[10px] text-dash-text-muted flex-shrink-0">{stateLabel[agent.status]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

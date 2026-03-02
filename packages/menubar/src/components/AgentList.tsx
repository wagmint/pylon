import type { Agent, AgentStatus } from "../lib/types";

const statusDot: Record<AgentStatus, string> = {
  idle: "bg-dash-text-muted",
  busy: "bg-dash-green",
  warning: "bg-dash-yellow",
  conflict: "bg-dash-red",
  blocked: "bg-dash-blue",
};

const statusLabel: Record<AgentStatus, string> = {
  idle: "Idle",
  busy: "Working",
  warning: "Warning",
  conflict: "Conflict",
  blocked: "Waiting",
};

function projectName(projectPath: string): string {
  const parts = projectPath.split("/");
  return parts[parts.length - 1] || projectPath;
}

interface AgentListProps {
  agents: Agent[];
}

export function AgentList({ agents }: AgentListProps) {
  const activeAgents = agents.filter((a) => a.isActive);
  const inactiveAgents = agents.filter((a) => !a.isActive);

  if (agents.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-xs text-dash-text-muted">No agents connected</p>
      </div>
    );
  }

  return (
    <div className="px-3 py-2">
      {activeAgents.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
            Active ({activeAgents.length})
          </span>
          {activeAgents.map((agent) => (
            <AgentRow key={agent.sessionId} agent={agent} />
          ))}
        </div>
      )}

      {inactiveAgents.length > 0 && (
        <div className={`space-y-1 ${activeAgents.length > 0 ? "mt-2" : ""}`}>
          <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
            Inactive ({inactiveAgents.length})
          </span>
          {inactiveAgents.slice(0, 3).map((agent) => (
            <AgentRow key={agent.sessionId} agent={agent} dimmed />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  dimmed = false,
}: {
  agent: Agent;
  dimmed?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-2.5 px-3 py-2 rounded-lg hover:bg-dash-surface-2 transition-colors ${
        dimmed ? "opacity-50" : ""
      }`}
    >
      <div
        className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${statusDot[agent.status]} ${
          agent.status === "busy" ? "animate-dash-pulse" : agent.status === "blocked" ? "animate-dash-breathe" : ""
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium text-dash-text truncate">
              {agent.label}
            </span>
            <span
              className="text-[8px] font-semibold px-1.5 py-0.5 rounded border font-mono flex-shrink-0"
              style={
                agent.agentType === "codex"
                  ? { color: "var(--dash-green)", borderColor: "rgba(0,232,123,0.3)", backgroundColor: "rgba(0,232,123,0.1)" }
                  : { color: "var(--dash-blue)", borderColor: "rgba(77,159,255,0.3)", backgroundColor: "rgba(77,159,255,0.1)" }
              }
            >
              {agent.agentType}
            </span>
          </div>
          <span className="text-[10px] text-dash-text-muted flex-shrink-0 ml-2">
            {statusLabel[agent.status]}
          </span>
        </div>
        {agent.currentTask && (
          <p className="text-[11px] text-dash-text-dim truncate mt-0.5">
            {agent.currentTask}
          </p>
        )}
        {agent.status === "warning" && (
          <p className="text-[10px] text-dash-yellow truncate mt-0.5">
            {agent.risk.spinningSignals.find((s) => s.level !== "nominal")
              ?.detail ?? "Errors in recent turns"}
          </p>
        )}
        {agent.status === "conflict" && (
          <p className="text-[10px] text-dash-red truncate mt-0.5">
            File collision detected
          </p>
        )}
        {agent.status === "blocked" && (
          <p className="text-[10px] text-dash-blue truncate mt-0.5">
            Waiting for your approval
          </p>
        )}
        <p className="text-[10px] text-dash-text-muted truncate">
          {projectName(agent.projectPath)}
        </p>
      </div>
    </div>
  );
}

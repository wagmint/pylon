import { useState } from "react";
import type { Agent, AgentStatus, Collision } from "../lib/types";

const statusDot: Record<AgentStatus, string> = {
  idle: "bg-dash-text-muted",
  busy: "bg-dash-green",
  warning: "bg-dash-green",
  conflict: "bg-dash-green",
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
  collisions: Collision[];
}

export function AgentList({ agents, collisions }: AgentListProps) {
  const activeAgents = agents.filter((a) => a.isActive);
  const inactiveAgents = agents.filter((a) => !a.isActive);

  if (agents.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-xs text-dash-text-muted">No agents connected</p>
      </div>
    );
  }

  const firstBlockedId = activeAgents.find((a) => a.status === "blocked")?.sessionId;

  return (
    <div className="px-3 py-2">
      {activeAgents.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
            Active ({activeAgents.length})
          </span>
          {activeAgents.map((agent) => (
            <AgentRow key={agent.sessionId} agent={agent} collisions={collisions} isFirstBlocked={agent.sessionId === firstBlockedId} />
          ))}
        </div>
      )}

      {inactiveAgents.length > 0 && (
        <div className={`space-y-1 ${activeAgents.length > 0 ? "mt-2" : ""}`}>
          <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
            Inactive ({inactiveAgents.length})
          </span>
          {inactiveAgents.slice(0, 3).map((agent) => (
            <AgentRow key={agent.sessionId} agent={agent} collisions={collisions} dimmed />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  collisions,
  dimmed = false,
  isFirstBlocked = false,
}: {
  agent: Agent;
  collisions: Collision[];
  isFirstBlocked?: boolean;
  dimmed?: boolean;
}) {
  const statusNotes = getStatusNotes(agent, collisions);
  const [deciding, setDeciding] = useState(false);

  async function handleDecide(action: "approve" | "deny") {
    setDeciding(true);
    try {
      await fetch(`http://localhost:7433/api/sessions/${agent.sessionId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch { /* server down — ignore */ }
    setDeciding(false);
  }

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
        {statusNotes.map((note, i) => (
          <p key={`${agent.sessionId}-status-note-${i}`} className={`text-[10px] truncate mt-0.5 ${note.className}`}>
            {note.text}
          </p>
        ))}
        {agent.status === "blocked" && agent.blockedOn && agent.blockedOn.length > 0 && (
          <>
            {agent.blockedOn.slice(0, 3).map((item, i) => (
              item.detail ? (
                <p key={item.requestId ?? i} className="text-[10px] text-dash-text-dim font-mono truncate mt-0.5">
                  {item.detail}
                </p>
              ) : null
            ))}
            {agent.blockedOn.length > 3 && (
              <p className="text-[10px] text-dash-text-muted mt-0.5">
                +{agent.blockedOn.length - 3} more
              </p>
            )}
          </>
        )}
        {agent.status === "blocked" && (
          <div className="flex items-center gap-1.5 mt-1">
            <button
              disabled={deciding}
              onClick={() => handleDecide("approve")}
              className="text-[10px] font-medium px-2 py-0.5 rounded bg-dash-green/15 text-dash-green hover:bg-dash-green/25 transition-colors disabled:opacity-50"
            >
              {agent.blockedOn && agent.blockedOn.length > 1 ? `Approve All (${agent.blockedOn.length})` : "Approve"}
              {isFirstBlocked && <span className="ml-1 opacity-50">↵</span>}
            </button>
            <button
              disabled={deciding}
              onClick={() => handleDecide("deny")}
              className="text-[10px] font-medium px-2 py-0.5 rounded bg-dash-red/15 text-dash-red hover:bg-dash-red/25 transition-colors disabled:opacity-50"
            >
              Deny
            </button>
          </div>
        )}
        <p className="text-[10px] text-dash-text-muted truncate">
          {projectName(agent.projectPath)}
        </p>
      </div>
    </div>
  );
}

const MAX_STATUS_NOTES = 2;

function getStatusNotes(agent: Agent, collisions: Collision[]): Array<{ text: string; className: string }> {
  if (agent.status === "blocked") {
    const items = agent.blockedOn ?? [];
    if (items.length === 0) {
      return [{ text: "Waiting for your approval", className: "text-dash-blue" }];
    }
    if (items.length === 1) {
      return [{ text: items[0].description, className: "text-dash-blue" }];
    }
    return [{ text: `${items.length} tools waiting for approval`, className: "text-dash-blue" }];
  }

  if (agent.status === "conflict") {
    const ownCollisions = collisions.filter((c) =>
      c.agents.some((a) => a.sessionId === agent.sessionId),
    );
    if (ownCollisions.length === 0) {
      return [{ text: "File collision detected", className: "text-dash-yellow" }];
    }

    const uniqueFiles = [...new Set(ownCollisions.map((c) => fileName(c.filePath)))];
    const first = uniqueFiles[0];
    const suffix = uniqueFiles.length > 1 ? ` (+${uniqueFiles.length - 1} more)` : "";
    return [
      { text: `Collision detected: ${first}${suffix}`, className: "text-dash-text-dim" },
      { text: `${ownCollisions.length} active collision${ownCollisions.length === 1 ? "" : "s"}`, className: "text-dash-text-dim" },
    ].slice(0, MAX_STATUS_NOTES);
  }

  if (agent.status === "warning") {
    const elevatedSignals = agent.risk.spinningSignals.filter((s) => s.level !== "nominal");
    if (elevatedSignals.length > 0) {
      return elevatedSignals
        .slice(0, MAX_STATUS_NOTES)
        .map((s) => ({ text: formatSignal(s.pattern, s.detail), className: "text-dash-text-dim" }));
    }
    const recentErrors = agent.risk.errorTrend.slice(-3).filter(Boolean).length;
    return [{ text: `Errors in recent turns (${recentErrors}/3)`, className: "text-dash-text-dim" }];
  }

  return [];
}

function formatSignal(pattern: string, detail: string): string {
  if (pattern === "stalled") return `Stalling: ${detail}`;
  if (pattern === "error_loop") return `Error loop: ${detail}`;
  if (pattern === "stuck") return `Stuck: ${detail}`;
  const name = pattern.replace(/_/g, " ");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}: ${detail}`;
}

function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

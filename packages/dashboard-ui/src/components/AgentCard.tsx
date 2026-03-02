"use client";

import type { Workstream, PlanStatus } from "../types";
import { AgentPip } from "./AgentPip";
import { OperatorTag } from "./OperatorTag";

interface AgentCardProps {
  workstream: Workstream;
  isSelected?: boolean;
  onSelect?: (projectPath: string) => void;
  onDecide?: (sessionId: string, action: "approve" | "deny") => void;
}

const planBadges: Partial<Record<PlanStatus, { label: string; className: string }>> = {
  drafting: { label: "PLANNING", className: "text-dash-purple bg-dash-purple/10" },
  implementing: { label: "BUILDING", className: "text-dash-yellow bg-dash-yellow/10" },
  rejected: { label: "REJECTED", className: "text-dash-red bg-dash-red/10" },
};

export function AgentCard({ workstream, isSelected, onSelect, onDecide }: AgentCardProps) {
  const hasActive = workstream.agents.some((a) => a.isActive);

  const activePlan = workstream.plans.find(p => p.status !== "none");
  const badge = activePlan ? planBadges[activePlan.status] : null;

  const hasTasks = workstream.planTasks.length > 0;
  const tasksDone = hasTasks
    ? workstream.planTasks.filter(t => t.status === "completed").length
    : 0;

  const hasBlocked = workstream.agents.some(a => a.status === "blocked");
  const hasBusy = workstream.agents.some(a => a.status === "busy");
  const stripColor = hasBlocked
    ? "border-l-dash-blue animate-dash-breathe"
    : hasBusy
      ? "border-l-dash-green animate-dash-pulse"
      : "border-l-dash-text-muted";

  return (
    <div
      onClick={() => onSelect?.(workstream.projectPath)}
      className={`px-3.5 py-2.5 border-b border-dash-border cursor-pointer transition-colors ${
        isSelected
          ? "bg-dash-blue/10 border-l-2 border-l-dash-blue"
          : hasActive ? `bg-dash-surface-2 border-l-2 ${stripColor}` : "hover:bg-dash-surface-2"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span className="font-display font-semibold text-xs text-dash-text">
            {workstream.name}
          </span>
          {badge && (
            <span className={`text-[8px] font-semibold px-1 py-px rounded ${badge.className}`}>
              {badge.label}
            </span>
          )}
        </div>
        <span className="text-[9px] text-dash-text-muted uppercase tracking-wide">
          {workstream.agents.length} agent{workstream.agents.length !== 1 ? "s" : ""}
        </span>
      </div>
      {hasTasks && (
        <div className="text-[9px] text-dash-text-muted mt-0.5">
          {tasksDone}/{workstream.planTasks.length} tasks done
        </div>
      )}
      <div className="mt-1.5 space-y-0.5">
        {workstream.agents.map((agent) =>
          agent.status === "blocked" && agent.blockedOn && agent.blockedOn.length > 0 ? (
            <div
              key={agent.sessionId}
              className="rounded border border-dash-blue/20 bg-dash-blue/5 px-2 py-1.5 -mx-0.5 space-y-1"
            >
              <div className="flex items-center gap-1.5">
                <AgentPip status={agent.status} />
                <span className="text-[10px] text-dash-text-dim shrink-0">{agent.label}</span>
                <span className={`text-[8px] font-semibold px-1 py-px rounded border font-mono shrink-0 ${
                  agent.agentType === "codex"
                    ? "text-dash-green border-dash-green/30 bg-dash-green/10"
                    : "text-dash-blue border-dash-blue/30 bg-dash-blue/10"
                }`}>
                  {agent.agentType === "codex" ? "codex" : "claude"}
                </span>
                <OperatorTag operatorId={agent.operatorId} />
              </div>
              {agent.blockedOn.map((item, i) => (
                <div key={item.requestId ?? i}>
                  <div className="text-[9px] text-dash-blue truncate">{item.description}</div>
                  {item.detail && (
                    <div className="text-[8px] text-dash-text-dim font-mono truncate" title={item.detail}>
                      {item.detail}
                    </div>
                  )}
                </div>
              ))}
              {onDecide && (
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); onDecide(agent.sessionId, "approve"); }}
                    className="text-[8px] font-semibold px-1.5 py-0.5 rounded bg-dash-green/15 text-dash-green hover:bg-dash-green/25 transition-colors"
                  >
                    {agent.blockedOn.length > 1 ? `Approve All (${agent.blockedOn.length})` : "Approve"}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDecide(agent.sessionId, "deny"); }}
                    className="text-[8px] font-semibold px-1.5 py-0.5 rounded bg-dash-red/15 text-dash-red hover:bg-dash-red/25 transition-colors"
                  >
                    Deny
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div
              key={agent.sessionId}
              className="flex items-center gap-1.5 rounded px-0.5 -mx-0.5 min-w-0"
            >
              <AgentPip status={agent.status} />
              <span className="text-[10px] text-dash-text-dim shrink-0">{agent.label}</span>
              <span className={`text-[8px] font-semibold px-1 py-px rounded border font-mono shrink-0 ${
                agent.agentType === "codex"
                  ? "text-dash-green border-dash-green/30 bg-dash-green/10"
                  : "text-dash-blue border-dash-blue/30 bg-dash-blue/10"
              }`}>
                {agent.agentType === "codex" ? "codex" : "claude"}
              </span>
              <OperatorTag operatorId={agent.operatorId} />
              {agent.currentTask ? (
                <span className="text-[9px] text-dash-text-dim truncate">{agent.currentTask}</span>
              ) : null}
            </div>
          )
        )}
      </div>
    </div>
  );
}

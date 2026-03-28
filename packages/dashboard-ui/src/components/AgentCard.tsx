"use client";

import { useRef, useState } from "react";
import type { Workstream, PlanStatus, Agent } from "../types";
import { AgentPip } from "./AgentPip";
import { ClampedText } from "./ClampedText";
import { OperatorTag } from "./OperatorTag";
import { DecideButtons } from "./DecideButtons";

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
  const decidedRef = useRef<Map<string, Agent>>(new Map());
  const [, bump] = useState(0);

  function onAgentDecided(sessionId: string) {
    const agent = workstream.agents.find((a) => a.sessionId === sessionId);
    if (agent) {
      decidedRef.current.set(sessionId, agent);
      setTimeout(() => {
        decidedRef.current.delete(sessionId);
        bump((n) => n + 1);
      }, 600);
    }
  }

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
            <span className={`text-2xs font-semibold px-1 py-px rounded ${badge.className}`}>
              {badge.label}
            </span>
          )}
        </div>
        <span className="text-2xs text-dash-text-muted uppercase tracking-wide">
          {workstream.agents.length} agent{workstream.agents.length !== 1 ? "s" : ""}
        </span>
      </div>
      {hasTasks && (
        <div className="text-2xs text-dash-text-muted mt-0.5">
          {tasksDone}/{workstream.planTasks.length} tasks done
        </div>
      )}
      <div className="mt-1.5 space-y-0.5">
        {workstream.agents.map((agent) => {
          const held = decidedRef.current.get(agent.sessionId);
          const showBlocked = (agent.status === "blocked" && agent.blockedOn && agent.blockedOn.length > 0) || held;
          const blockedAgent = held && agent.status !== "blocked" ? held : agent;
          return showBlocked ? (
            <div
              key={agent.sessionId}
              className="rounded border border-dash-blue/20 bg-dash-blue/5 px-2 py-1.5 -mx-0.5 space-y-1"
            >
              <div className="flex items-center gap-1.5">
                <AgentPip status={agent.status} />
                <span className="text-xs text-dash-text-dim shrink-0">{agent.label}</span>
                <span className={`text-2xs font-semibold px-1 py-px rounded border font-mono shrink-0 ${
                  agent.agentType === "codex"
                    ? "text-dash-green border-dash-green/30 bg-dash-green/10"
                    : "text-dash-blue border-dash-blue/30 bg-dash-blue/10"
                }`}>
                  {agent.agentType === "codex" ? "codex" : "claude"}
                </span>
                <OperatorTag operatorId={agent.operatorId} />
              </div>
              {(blockedAgent.blockedOn ?? []).map((item, i) => (
                <div key={item.requestId ?? i}>
                  <div className="text-2xs text-dash-blue truncate">{item.description}</div>
                  {item.detail && (
                    <div className="text-2xs text-dash-text-dim font-mono truncate" title={item.detail}>
                      {item.detail}
                    </div>
                  )}
                </div>
              ))}
              {onDecide && (
                <div className="pt-0.5">
                  <DecideButtons
                    sessionId={agent.sessionId}
                    itemCount={(blockedAgent.blockedOn ?? []).length}
                    size="xs"
                    onDecide={onDecide}
                    onDecided={() => onAgentDecided(agent.sessionId)}
                  />
                </div>
              )}
            </div>
          ) : (
            <div
              key={agent.sessionId}
              className="rounded px-0.5 -mx-0.5 min-w-0"
            >
              <div className="flex items-center gap-1.5">
                <AgentPip status={agent.status} />
                <span className="text-xs text-dash-text-dim shrink-0">{agent.label}</span>
                <span className={`text-2xs font-semibold px-1 py-px rounded border font-mono shrink-0 ${
                  agent.agentType === "codex"
                    ? "text-dash-green border-dash-green/30 bg-dash-green/10"
                    : "text-dash-blue border-dash-blue/30 bg-dash-blue/10"
                }`}>
                  {agent.agentType === "codex" ? "codex" : "claude"}
                </span>
                <OperatorTag operatorId={agent.operatorId} />
              </div>
              {agent.currentTask && (
                <div className="mt-0.5 pl-5">
                  <ClampedText text={agent.currentTask} lines={2} className="text-2xs text-dash-text-dim" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import type { Workstream, IntentTaskView, AgentStatus } from "../types";
import { OperatorTag } from "./OperatorTag";
import { timeAgo } from "../utils";

interface WorkstreamNodeProps {
  workstream: Workstream;
}

const intentStatusBadge: Record<Workstream["intentStatus"], { label: string; className: string }> = {
  on_plan: { label: "ON PLAN", className: "text-dash-green bg-dash-green/10" },
  drifting: { label: "DRIFTING", className: "text-dash-yellow bg-dash-yellow/10" },
  blocked: { label: "BLOCKED", className: "text-dash-red bg-dash-red/10" },
  no_clear_intent: { label: "NO INTENT", className: "text-dash-text-muted bg-dash-surface-2" },
};

const agentDot: Record<AgentStatus, string> = {
  busy: "bg-dash-green animate-pulse",
  idle: "bg-dash-text-muted",
  warning: "bg-dash-yellow",
  conflict: "bg-dash-red",
  blocked: "bg-dash-blue animate-dash-breathe",
};

const taskStatusIcon: Record<IntentTaskView["state"], { char: string; className: string }> = {
  completed: { char: "\u2713", className: "text-dash-green" },
  in_progress: { char: "\u2192", className: "text-dash-blue animate-pulse" },
  blocked: { char: "\u2715", className: "text-dash-red" },
  pending: { char: "\u2013", className: "text-dash-text-muted" },
  unplanned: { char: "+", className: "text-dash-yellow" },
};

const confidenceClass: Record<Workstream["intentConfidence"], string> = {
  high: "text-dash-green",
  medium: "text-dash-yellow",
  low: "text-dash-red",
};

function MetricHelp({ text, align = "center" }: { text: string; align?: "left" | "center" | "right" }) {
  const posClass = align === "left"
    ? "left-0"
    : align === "right"
      ? "right-0"
      : "left-1/2 -translate-x-1/2";

  return (
    <span className="relative inline-flex items-center group z-30">
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-dash-border text-2xs text-dash-text-muted cursor-help">
        ?
      </span>
      <span className={`pointer-events-none absolute top-full z-[9999] mt-1.5 w-44 max-w-[12rem] rounded border border-dash-border bg-dash-surface px-1.5 py-1 text-2xs leading-snug text-dash-text opacity-0 shadow-md transition-opacity group-hover:opacity-100 whitespace-normal ${posClass}`}>
        {text}
      </span>
    </span>
  );
}

function renderTask(task: IntentTaskView) {
  const icon = taskStatusIcon[task.state];
  const pieces: string[] = [];
  if (task.evidence.edits > 0) pieces.push(`${task.evidence.edits} edit${task.evidence.edits !== 1 ? "s" : ""}`);
  if (task.evidence.commits > 0) pieces.push(`${task.evidence.commits} commit${task.evidence.commits !== 1 ? "s" : ""}`);
  if (task.evidence.lastTouchedAt) pieces.push(timeAgo(task.evidence.lastTouchedAt));
  const evidence = pieces.join(" \u2022 ");

  return (
    <div key={task.id} className="flex items-center gap-1.5 text-xs text-dash-text-dim">
      <span className={`text-2xs w-3 text-center shrink-0 ${icon.className}`}>{icon.char}</span>
      <span className="truncate">{task.subject}</span>
      {task.ownerLabel && <span className="text-dash-blue shrink-0">{task.ownerLabel}</span>}
      {evidence && <span className="text-2xs text-dash-text-muted truncate">{evidence}</span>}
    </div>
  );
}

function getCodexBadge(workstream: Workstream): { label: string; className: string } {
  const hasWarning = workstream.agents.some(a => a.status === "warning");
  if (hasWarning) return { label: "ERRORS", className: "text-dash-red bg-dash-red/10" };
  const hasBusy = workstream.agents.some(a => a.status === "busy");
  if (hasBusy) return { label: "EXECUTING", className: "text-dash-green bg-dash-green/10" };
  return { label: "IDLE", className: "text-dash-text-muted bg-dash-surface-2" };
}

export function WorkstreamNode({ workstream }: WorkstreamNodeProps) {
  const isCodex = workstream.mode === "codex";
  const hasBusy = workstream.agents.some(a => a.status === "busy");
  const statusColor = hasBusy
    ? "bg-dash-green animate-dash-pulse"
    : "bg-dash-green";

  const badge = isCodex
    ? getCodexBadge(workstream)
    : intentStatusBadge[workstream.intentStatus];
  const coverageHelp = "Share of planned tasks that are active or done.";
  const driftHelp = "Share of work happening outside planned tasks.";
  const confidenceHelp = "How reliable the intent mapping is.";

  return (
    <div className="relative z-0 hover:z-30 flex gap-2.5 px-3.5 py-2 border-b border-dash-border items-start">
      <div className={`w-[3px] min-h-[32px] rounded-sm ${statusColor} mt-0.5 shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="font-display font-semibold text-xs">
            {workstream.name}
          </span>
          <span className={`text-2xs font-semibold px-1 py-px rounded ${badge.className}`}>
            {badge.label}
          </span>
        </div>
        <div className="flex gap-2.5 text-2xs text-dash-text-muted">
          <span className="text-dash-green">
            {workstream.agents.filter((a) => a.isActive).length} active
          </span>
          {isCodex ? (
            <>
              <span>{workstream.totalCommands} cmds</span>
              <span>{workstream.totalPatches} files</span>
              <span>{workstream.commits} commits</span>
              {workstream.errors > 0 && (
                <span className="text-dash-red">{workstream.errors} errors</span>
              )}
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 text-dash-green">
                <span>{workstream.intentCoveragePct}% coverage</span>
                <MetricHelp text={coverageHelp} align="left" />
              </span>
              <span className={`inline-flex items-center gap-1 ${workstream.driftPct > 0 ? "text-dash-yellow" : ""}`}>
                <span>{workstream.driftPct}% drift</span>
                <MetricHelp text={driftHelp} align="left" />
              </span>
              <span className={`inline-flex items-center gap-1 ${confidenceClass[workstream.intentConfidence]}`}>
                <span>{workstream.intentConfidence} confidence</span>
                <MetricHelp text={confidenceHelp} align="right" />
              </span>
            </>
          )}
          {workstream.lastIntentUpdateAt && (
            <span>updated {timeAgo(workstream.lastIntentUpdateAt)}</span>
          )}
          {workstream.hasCollision && (
            <span className="text-dash-yellow font-semibold">COLLISION</span>
          )}
        </div>

        <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-1">
          {workstream.agents.map((agent) => (
            <div key={agent.sessionId} className="flex items-center gap-1 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${agentDot[agent.status]}`} />
              <span className="text-dash-text-dim">{agent.label}</span>
              <span className={`text-2xs font-semibold px-0.5 rounded font-mono ${
                agent.agentType === "codex"
                  ? "text-dash-green/70"
                  : "text-dash-blue/70"
              }`}>
                {agent.agentType === "codex" ? "codex" : "claude"}
              </span>
              <OperatorTag operatorId={agent.operatorId} />
            </div>
          ))}
        </div>

        {!isCodex && workstream.driftReasons.length > 0 && (
          <div className="mt-1 text-2xs text-dash-yellow">
            {workstream.driftReasons.slice(0, 2).join(" \u2022 ")}
          </div>
        )}

        <div className="mt-1.5 pl-1 space-y-1">
          {workstream.intentLanes.inProgress.length > 0 && (
            <div>
              <div className="text-2xs text-dash-blue mb-0.5">Planned + In Progress</div>
              <div className="space-y-0.5">
                {workstream.intentLanes.inProgress.slice(0, 4).map(renderTask)}
              </div>
            </div>
          )}
          {workstream.intentLanes.done.length > 0 && (
            <div>
              <div className="text-2xs text-dash-green mb-0.5">Planned + Done</div>
              <div className="space-y-0.5">
                {workstream.intentLanes.done.slice(0, 3).map(renderTask)}
              </div>
            </div>
          )}
          {workstream.intentLanes.unplanned.length > 0 && (
            <div>
              <div className="text-2xs text-dash-yellow mb-0.5">Unplanned Work</div>
              <div className="space-y-0.5">
                {workstream.intentLanes.unplanned.slice(0, 3).map(renderTask)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

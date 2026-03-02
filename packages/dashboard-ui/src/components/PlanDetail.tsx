"use client";

import { useState } from "react";
import type { SessionPlan, Workstream, DraftingActivity, IntentTaskView, AgentType } from "../types";
import { OperatorTag } from "./OperatorTag";
import { timeAgo, formatDuration } from "../utils";

interface PlanDetailProps {
  workstreams: Workstream[];
}

interface PlanEntry {
  workstreamName: string;
  plan: SessionPlan;
  title: string;
  tasksDone: number;
  tasksTotal: number;
  operatorId: string;
  agentType: AgentType;
}

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  drafting: { label: "DRAFTING", color: "text-dash-purple", bg: "bg-dash-purple-dim" },
  implementing: { label: "IMPLEMENTING", color: "text-dash-yellow", bg: "bg-dash-yellow-dim" },
  completed: { label: "COMPLETED", color: "text-dash-green", bg: "bg-dash-green-dim" },
  rejected: { label: "REJECTED", color: "text-dash-red", bg: "bg-dash-red-dim" },
};

function extractTitle(md: string | null): string {
  if (!md) return "Untitled plan";
  const match = md.match(/^#\s+(.+)/m);
  return match ? match[1].slice(0, 60) : "Untitled plan";
}

function collectPlans(workstreams: Workstream[]): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const ws of workstreams) {
    for (const plan of ws.plans) {
      if (plan.status === "none" || plan.status === "rejected") continue;
      const done = plan.tasks.filter((t) => t.status === "completed").length;
      const matchingAgent = ws.agents.find((a) => a.label === plan.agentLabel);
      entries.push({
        workstreamName: ws.name,
        plan,
        title: extractTitle(plan.markdown),
        tasksDone: done,
        tasksTotal: plan.tasks.length,
        operatorId: matchingAgent?.operatorId ?? "self",
        agentType: matchingAgent?.agentType ?? "claude",
      });
    }
  }
  return entries.sort((a, b) =>
    new Date(b.plan.timestamp).getTime() - new Date(a.plan.timestamp).getTime()
  );
}

function draftingSummaryLine(activity: DraftingActivity): string {
  const parts: string[] = [];
  if (activity.filesExplored.length > 0)
    parts.push(`${activity.filesExplored.length} files read`);
  if (activity.searches.length > 0)
    parts.push(`${activity.searches.length} searches`);
  if (activity.turnCount > 0)
    parts.push(`${activity.turnCount} turns`);
  return parts.length > 0 ? `Exploring \u2014 ${parts.join(", ")}` : "Exploring codebase\u2026";
}

function DraftingActivityPanel({ activity, planTimestamp }: { activity: DraftingActivity; planTimestamp: string }) {
  const [showFiles, setShowFiles] = useState(false);
  const [showSearches, setShowSearches] = useState(false);
  const elapsed = new Date(activity.lastActivityAt).getTime() - new Date(planTimestamp).getTime();
  const toolEntries = Object.entries(activity.toolCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-dash-purple opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-dash-purple" />
        </span>
        <span className="text-[11px] text-dash-text">
          {activity.approachSummary || "Exploring codebase\u2026"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-dash-text-dim">
        {elapsed > 0 && <span>Drafting for {formatDuration(elapsed)}</span>}
        <span>{activity.turnCount} turns</span>
      </div>
      {toolEntries.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {toolEntries.map(([tool, count]) => (
            <span key={tool} className="text-[9px] px-1.5 py-0.5 rounded bg-dash-surface-2 text-dash-text-dim">
              {tool}: {count}
            </span>
          ))}
        </div>
      )}
      {activity.filesExplored.length > 0 && (
        <div>
          <button onClick={() => setShowFiles(!showFiles)} className="text-[10px] text-dash-text-dim hover:text-dash-text transition-colors">
            Read {activity.filesExplored.length} files {showFiles ? "\u25B4" : "\u25BE"}
          </button>
          {showFiles && (
            <div className="mt-1 pl-2 space-y-px max-h-32 overflow-y-auto">
              {activity.filesExplored.map((f, i) => (
                <div key={i} className="text-[9px] text-dash-text-muted truncate">{f}</div>
              ))}
            </div>
          )}
        </div>
      )}
      {activity.searches.length > 0 && (
        <div>
          <button onClick={() => setShowSearches(!showSearches)} className="text-[10px] text-dash-text-dim hover:text-dash-text transition-colors">
            {activity.searches.length} searches {showSearches ? "\u25B4" : "\u25BE"}
          </button>
          {showSearches && (
            <div className="mt-1 pl-2 space-y-px max-h-32 overflow-y-auto">
              {activity.searches.map((s, i) => (
                <div key={i} className="text-[9px] text-dash-text-muted truncate">{s}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const taskIcon: Record<string, { char: string; className: string }> = {
  completed: { char: "\u2713", className: "text-dash-green" },
  in_progress: { char: "\u25B6", className: "text-dash-blue" },
  pending: { char: "\u25CB", className: "text-dash-text-muted" },
  deleted: { char: "\u2212", className: "text-dash-text-muted opacity-40" },
};

function PlanOverview({ entries, onSelect }: { entries: PlanEntry[]; onSelect: (idx: number) => void }) {
  const [expandedPlanKeys, setExpandedPlanKeys] = useState<Set<string>>(new Set());

  if (entries.length === 0) {
    return <div className="h-full flex items-center justify-center text-dash-text-muted text-xs">No active plans</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center px-3.5 py-2.5 border-b border-dash-border bg-dash-surface">
        <span className="font-display font-bold text-xs text-dash-text">Plans</span>
        <span className="ml-2 text-[9px] text-dash-text-muted">{entries.length} total</span>
      </div>
      {entries.map((entry, i) => {
        const cfg = statusConfig[entry.plan.status];
        const planKey = `${entry.operatorId}:${entry.plan.agentLabel}:${entry.plan.timestamp}:${entry.title}`;
        const isExpanded = expandedPlanKeys.has(planKey);
        return (
          <div key={planKey} className="border-b border-dash-border">
            <button onClick={() => onSelect(i)} className="w-full flex items-center gap-3 px-3.5 py-2 hover:bg-dash-surface-2 transition-colors text-left">
              <div className={`w-[3px] h-8 rounded-sm shrink-0 ${
                entry.plan.status === "completed" ? "bg-dash-green"
                  : entry.plan.status === "implementing" ? "bg-dash-yellow"
                  : entry.plan.status === "drafting" ? "bg-dash-purple"
                  : entry.plan.status === "rejected" ? "bg-dash-red"
                  : "bg-dash-text-muted"
              }`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-dash-text truncate">{entry.title}</span>
                  {cfg && (
                    <span className={`text-[7px] font-bold tracking-widest uppercase px-1 py-px rounded shrink-0 ${cfg.bg} ${cfg.color}`}>
                      {cfg.label}
                    </span>
                  )}
                  {entry.agentType === "codex" && (
                    <span className="text-[7px] font-bold tracking-widest uppercase px-1 py-px rounded shrink-0 bg-dash-green-dim text-dash-green">
                      CODEX
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-[9px] text-dash-text-muted">
                  <span className="font-semibold text-dash-text-dim">{entry.plan.agentLabel}</span>
                  <OperatorTag operatorId={entry.operatorId} />
                  <span>{entry.workstreamName}</span>
                  {entry.tasksTotal > 0 && (
                    <span
                      className="cursor-pointer transition-colors px-1 py-px rounded border border-dash-border hover:border-dash-text-muted hover:bg-dash-surface-2 text-dash-text-dim"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedPlanKeys((prev) => {
                          const next = new Set(prev);
                          if (isExpanded) next.delete(planKey);
                          else next.add(planKey);
                          return next;
                        });
                      }}
                    >
                      {entry.tasksDone}/{entry.tasksTotal} tasks {isExpanded ? "\u25B4" : "\u25BE"}
                    </span>
                  )}
                  {entry.plan.planDurationMs != null && <span>planned in {formatDuration(entry.plan.planDurationMs)}</span>}
                  <span>{timeAgo(entry.plan.timestamp)}</span>
                </div>
                {entry.plan.status === "drafting" && entry.plan.draftingActivity && (
                  <div className="text-[9px] text-dash-purple mt-0.5 truncate">
                    {draftingSummaryLine(entry.plan.draftingActivity)}
                  </div>
                )}
              </div>
              <span className="text-dash-text-muted text-[10px] shrink-0">&rsaquo;</span>
            </button>
            {isExpanded && entry.plan.tasks.length > 0 && (
              <div className="px-3.5 pb-2 pl-8 space-y-px">
                {entry.plan.tasks.map((task, ti) => {
                  const icon = taskIcon[task.status] ?? taskIcon.pending;
                  return (
                    <div key={`${task.id}-${ti}`} className="flex items-center gap-1.5 text-[10px] text-dash-text-dim">
                      <span className={`text-[9px] w-3 text-center shrink-0 ${icon.className}`}>{icon.char}</span>
                      <span className={`truncate ${task.status === "completed" ? "line-through opacity-50" : ""}`}>{task.subject}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2]) parts.push(<strong key={match.index} className="font-semibold text-dash-text">{match[2]}</strong>);
    else if (match[3]) parts.push(<code key={match.index} className="bg-dash-surface-2 text-dash-blue px-1 py-0.5 rounded text-[10px]">{match[3]}</code>);
    else if (match[4]) parts.push(<em key={match.index}>{match[4]}</em>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function renderMarkdown(md: string): React.ReactNode[] {
  const lines = md.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizes = ["text-sm font-bold", "text-xs font-bold", "text-[11px] font-semibold", "text-[11px] font-semibold text-dash-text-dim"];
      nodes.push(<div key={i} className={`${sizes[level - 1]} mt-2 mb-1`}>{renderInline(headingMatch[2])}</div>);
      i++; continue;
    }
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1]?.match(/^\|[\s\-:|]+\|$/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) { tableLines.push(lines[i]); i++; }
      const parseRow = (l: string) => l.split("|").slice(1, -1).map(c => c.trim());
      const headers = parseRow(tableLines[0]);
      const rows = tableLines.slice(2).map(parseRow);
      nodes.push(
        <div key={`table-${i}`} className="overflow-x-auto my-1">
          <table className="w-full text-[10px] border-collapse">
            <thead><tr>{headers.map((h, hi) => <th key={hi} className="text-left px-2 py-1 border-b border-dash-border font-semibold text-dash-text-dim">{renderInline(h)}</th>)}</tr></thead>
            <tbody>{rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} className="px-2 py-1 border-b border-dash-border text-dash-text-dim">{renderInline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (ulMatch) {
      const indent = Math.floor(ulMatch[1].length / 2);
      nodes.push(<div key={i} className="flex gap-1.5" style={{ paddingLeft: `${indent * 12}px` }}><span className="text-dash-text-muted shrink-0">&#x2022;</span><span>{renderInline(ulMatch[2])}</span></div>);
      i++; continue;
    }
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      const indent = Math.floor(olMatch[1].length / 2);
      const numMatch = line.match(/^(\s*)(\d+)\./);
      nodes.push(<div key={i} className="flex gap-1.5" style={{ paddingLeft: `${indent * 12}px` }}><span className="text-dash-text-muted shrink-0">{numMatch?.[2]}.</span><span>{renderInline(olMatch[2])}</span></div>);
      i++; continue;
    }
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      nodes.push(<pre key={`code-${i}`} className="bg-dash-surface-2 rounded p-2 text-[10px] text-dash-text-dim overflow-x-auto my-1">{codeLines.join("\n")}</pre>);
      continue;
    }
    if (line.trim() === "") { nodes.push(<div key={i} className="h-1.5" />); i++; continue; }
    nodes.push(<div key={i} className="leading-relaxed">{renderInline(line)}</div>);
    i++;
  }
  return nodes;
}

function PlanMarkdownView({ entry, onBack }: { entry: PlanEntry; onBack: () => void }) {
  const cfg = statusConfig[entry.plan.status];
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-dash-border bg-dash-surface">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="text-dash-text-muted hover:text-dash-text text-xs transition-colors">&lsaquo; Plans</button>
          <span className="text-dash-border">|</span>
          <span className="font-display font-semibold text-[11px] text-dash-text truncate">{entry.title}</span>
          {cfg && <span className={`text-[8px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[9px] text-dash-text-dim font-semibold">{entry.plan.agentLabel}</span>
          <OperatorTag operatorId={entry.operatorId} />
          <span className="text-[9px] text-dash-text-muted">{timeAgo(entry.plan.timestamp)}</span>
          {entry.tasksTotal > 0 && <span className="text-[9px] text-dash-text-muted">{entry.tasksDone}/{entry.tasksTotal} tasks</span>}
        </div>
      </div>
      <div className="px-3.5 py-2.5 text-[11px] text-dash-text-dim">
        {entry.plan.markdown ? renderMarkdown(entry.plan.markdown)
          : entry.plan.status === "drafting" && entry.plan.draftingActivity
            ? <DraftingActivityPanel activity={entry.plan.draftingActivity} planTimestamp={entry.plan.timestamp} />
            : <div className="text-dash-text-muted text-xs">No plan content</div>}
      </div>
    </div>
  );
}

const intentStatusLabel: Record<Workstream["intentStatus"], string> = { on_plan: "ON PLAN", drifting: "DRIFTING", blocked: "BLOCKED", no_clear_intent: "NO INTENT" };
const intentStatusClass: Record<Workstream["intentStatus"], string> = { on_plan: "text-dash-green bg-dash-green-dim", drifting: "text-dash-yellow bg-dash-yellow-dim", blocked: "text-dash-red bg-dash-red-dim", no_clear_intent: "text-dash-text-muted bg-dash-surface-2" };

function renderIntentTask(task: IntentTaskView) {
  const stateClass = task.state === "completed" ? "text-dash-green" : task.state === "in_progress" ? "text-dash-blue" : task.state === "blocked" ? "text-dash-red" : task.state === "unplanned" ? "text-dash-yellow" : "text-dash-text-muted";
  const evidenceParts: string[] = [];
  if (task.evidence.edits > 0) evidenceParts.push(`${task.evidence.edits} edits`);
  if (task.evidence.commits > 0) evidenceParts.push(`${task.evidence.commits} commits`);
  if (task.evidence.lastTouchedAt) evidenceParts.push(timeAgo(task.evidence.lastTouchedAt));
  return (
    <div key={task.id} className="border border-dash-border rounded px-2 py-1.5 bg-dash-surface/40">
      <div className="flex items-center gap-1.5">
        <span className={`text-[8px] font-semibold tracking-widest ${stateClass}`}>{task.state.replace("_", " ").toUpperCase()}</span>
        {task.ownerLabel && <span className="text-[9px] text-dash-blue">{task.ownerLabel}</span>}
      </div>
      <div className="text-[10px] text-dash-text truncate">{task.subject}</div>
      {evidenceParts.length > 0 && <div className="text-[9px] text-dash-text-muted mt-0.5">{evidenceParts.join(" \u2022 ")}</div>}
    </div>
  );
}

function PlanVsRealityView({ workstream }: { workstream: Workstream }) {
  const activePlan = workstream.plans.filter(p => p.status !== "none").sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  return (
    <div className="h-full overflow-y-auto">
      <div className="px-3.5 py-2.5 border-b border-dash-border bg-dash-surface">
        <div className="flex items-center gap-2">
          <span className="font-display font-bold text-xs text-dash-text">{workstream.name}</span>
          <span className={`text-[8px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded ${intentStatusClass[workstream.intentStatus]}`}>{intentStatusLabel[workstream.intentStatus]}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-1 text-[9px] text-dash-text-muted">
          <span className="text-dash-green">{workstream.intentCoveragePct}% coverage</span>
          <span className={workstream.driftPct > 0 ? "text-dash-yellow" : ""}>{workstream.driftPct}% drift</span>
          <span className={workstream.intentConfidence === "high" ? "text-dash-green" : workstream.intentConfidence === "medium" ? "text-dash-yellow" : "text-dash-red"}>{workstream.intentConfidence} confidence</span>
          {workstream.lastIntentUpdateAt && <span>updated {timeAgo(workstream.lastIntentUpdateAt)}</span>}
          {activePlan && <span>plan: {extractTitle(activePlan.markdown)}</span>}
        </div>
        {workstream.driftReasons.length > 0 && <div className="text-[9px] text-dash-yellow mt-1">{workstream.driftReasons.slice(0, 3).join(" \u2022 ")}</div>}
      </div>
      <div className="grid grid-cols-2 gap-px bg-dash-border min-h-0">
        <div className="bg-dash-bg px-3.5 py-2.5">
          <div className="text-[10px] font-semibold text-dash-text mb-2">Canonical Intent</div>
          <div className="space-y-2">
            <div>
              <div className="text-[9px] text-dash-blue mb-1">Planned + In Progress</div>
              {workstream.intentLanes.inProgress.length > 0 ? <div className="space-y-1">{workstream.intentLanes.inProgress.slice(0, 12).map(renderIntentTask)}</div> : <div className="text-[9px] text-dash-text-muted">No active planned tasks</div>}
            </div>
            <div>
              <div className="text-[9px] text-dash-green mb-1">Planned + Done</div>
              {workstream.intentLanes.done.length > 0 ? <div className="space-y-1">{workstream.intentLanes.done.slice(0, 12).map(renderIntentTask)}</div> : <div className="text-[9px] text-dash-text-muted">No completed planned tasks</div>}
            </div>
          </div>
        </div>
        <div className="bg-dash-bg px-3.5 py-2.5">
          <div className="text-[10px] font-semibold text-dash-text mb-2">Reality</div>
          <div>
            <div className="text-[9px] text-dash-yellow mb-1">Unplanned Work</div>
            {workstream.intentLanes.unplanned.length > 0 ? <div className="space-y-1">{workstream.intentLanes.unplanned.slice(0, 16).map(renderIntentTask)}</div> : <div className="text-[9px] text-dash-text-muted">No unplanned work detected</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlanDetail({ workstreams }: PlanDetailProps) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const entries = collectPlans(workstreams);
  if (selectedIdx !== null && selectedIdx < entries.length) return <PlanMarkdownView entry={entries[selectedIdx]} onBack={() => setSelectedIdx(null)} />;
  return <PlanOverview entries={entries} onSelect={setSelectedIdx} />;
}

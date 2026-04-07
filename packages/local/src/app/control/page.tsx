"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getAnalyticsState,
  getControlState,
  type AnalyticsState,
  type ControlState,
  type ControlWorkstream,
  type ControlTask,
  type ControlSession,
  type ControlBlocker,
  type ControlEvidence,
} from "@/lib/control-api";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return ((n / d) * 100).toFixed(1) + "%";
}

function timeAgo(value: string | null | undefined): string {
  if (!value) return "";
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 3
    ? parts.join("/")
    : "\u2026/" + parts.slice(-3).join("/");
}

function fileName(p: string): string {
  return p.split("/").pop() || p;
}

const STATUS_DOT: Record<string, string> = {
  in_progress: "bg-dash-blue",
  blocked: "bg-dash-red",
  stalled: "bg-dash-yellow",
  completed: "bg-dash-green",
  idle: "bg-dash-text-dim",
};

const STATUS_TEXT: Record<string, string> = {
  in_progress: "text-dash-blue",
  blocked: "text-dash-red",
  stalled: "text-dash-yellow",
  completed: "text-dash-green",
  idle: "text-dash-text-dim",
};

const STATUS_BORDER_L: Record<string, string> = {
  in_progress: "border-l-2 border-l-dash-blue",
  blocked: "border-l-2 border-l-dash-red",
  stalled: "border-l-2 border-l-dash-yellow",
  completed: "border-l-2 border-l-dash-green",
  idle: "border-l-2 border-l-dash-border",
};

const STATUS_PULSE: Record<string, string> = {
  in_progress: "animate-dash-pulse",
  blocked: "animate-dash-pulse",
};

const STATUS_LABEL: Record<string, string> = {
  in_progress: "Active \u2014 session has a goal and is executing",
  blocked: "Blocked \u2014 waiting on approval or plan was rejected",
  stalled: "Stalled \u2014 last turn ended with an error",
  completed: "Completed \u2014 last turn produced a commit",
  idle: "Idle \u2014 no goal or action detected",
};

function sessionRecency(
  s: ControlSession,
): "live" | "recent" | "archived" {
  const ts = s.state?.lastEventAt || s.row.lastEventAt;
  if (!ts) return "archived";
  const age = Date.now() - Date.parse(ts);
  if (age < 10 * 60_000) return "live";
  if (age < 24 * 3600_000) return "recent";
  return "archived";
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function StatBox({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded border border-dash-border bg-dash-surface px-4 py-3 min-w-0 hover:border-dash-border-light transition-colors overflow-hidden relative">
      {accent && (
        <div
          className="absolute top-0 left-0 right-0 h-0.5"
          style={{ backgroundColor: accent }}
        />
      )}
      <div className="text-2xs text-dash-text-muted uppercase tracking-[1px] font-semibold">
        {label}
      </div>
      <div className="text-xl text-dash-text mt-1 font-mono font-medium tabular-nums">
        {value}
      </div>
      {sub && (
        <div className="text-2xs text-dash-text-dim mt-0.5 font-mono tabular-nums">
          {sub}
        </div>
      )}
    </div>
  );
}

function Dot({ status }: { status: string }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[status] ?? "bg-dash-text-muted"} ${STATUS_PULSE[status] ?? ""}`}
    />
  );
}

function SectionHead({
  title,
  subtitle,
  count,
}: {
  title: string;
  subtitle: string;
  count?: number;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-3">
        <h2 className="text-2xs text-dash-text-muted uppercase font-semibold tracking-[1.5px]">
          {title}
        </h2>
        {count != null && (
          <span className="bg-dash-surface-3 px-1.5 py-0.5 rounded font-mono tabular-nums text-2xs text-dash-text-muted">
            {count}
          </span>
        )}
        <div className="flex-1 border-t border-dash-border" />
      </div>
      <div className="text-2xs text-dash-text-dim mt-1">{subtitle}</div>
    </div>
  );
}

function ExpandBtn({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="text-dash-text-muted hover:text-dash-text transition-colors text-xs w-5 text-center flex-shrink-0"
    >
      {open ? "\u25BE" : "\u25B8"}
    </button>
  );
}

function EvidencePanel({
  evidence,
  max = 5,
}: {
  evidence: ControlEvidence[];
  max?: number;
}) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 pl-4 border-l border-dash-border/50">
      <div className="text-2xs text-dash-text-muted uppercase tracking-wider mb-1 font-semibold">
        Why this exists
      </div>
      {evidence.slice(0, max).map((e, i) => (
        <div key={i} className="text-2xs text-dash-text-dim flex gap-2">
          <span className="text-dash-text-muted flex-shrink-0 w-28 truncate">
            {e.evidenceType}
          </span>
          {e.snippet && (
            <span className="truncate">{e.snippet.slice(0, 140)}</span>
          )}
        </div>
      ))}
      {evidence.length > max && (
        <div className="text-2xs text-dash-text-muted">
          +{evidence.length - max} more
        </div>
      )}
    </div>
  );
}

function BlockerList({ blockers }: { blockers: ControlBlocker[] }) {
  const active = blockers.filter((b) => b.row.status === "active");
  if (active.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {active.map((b) => (
        <div
          key={b.row.id}
          className="text-2xs flex items-center gap-2 text-dash-red/80"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-dash-red flex-shrink-0 animate-dash-pulse" />
          <span className="truncate">
            {b.row.title}
            {b.row.summary ? ` \u2014 ${b.row.summary}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Counters
// ---------------------------------------------------------------------------

function CountersSection({
  analytics,
  control,
}: {
  analytics: AnalyticsState;
  control: ControlState;
}) {
  const t = analytics.cost.totals;
  const totalInput = t.inputTokens + t.cacheReadTokens;
  const cacheHit = totalInput > 0 ? pct(t.cacheReadTokens, totalInput) : "0%";
  const taskCount = control.workstreams.reduce(
    (s, w) => s + w.counts.tasks,
    0,
  );

  return (
    <section>
      <SectionHead
        title="Overview"
        subtitle="Total activity captured across all Claude Code sessions"
      />
      <div className="grid grid-cols-6 gap-3">
        <StatBox label="Sessions" value={fmt(t.sessions)} accent="var(--dash-blue)" />
        <StatBox label="Turns" value={fmt(t.turns)} accent="var(--dash-blue)" />
        <StatBox label="Tasks" value={String(taskCount)} accent="var(--dash-green)" />
        <StatBox
          label="Workstreams"
          value={String(control.workstreams.length)}
          accent="var(--dash-green)"
        />
        <StatBox
          label="Output Tokens"
          value={fmt(t.outputTokens)}
          sub={`${fmt(t.inputTokens)} input`}
          accent="var(--dash-purple)"
        />
        <StatBox
          label="Cache Hit"
          value={cacheHit}
          sub={fmt(t.cacheReadTokens)}
          accent="var(--dash-purple)"
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section: Workstreams
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  expanded,
  onToggle,
}: {
  task: ControlTask;
  expanded: boolean;
  onToggle: () => void;
}) {
  const r = task.row;
  const status = r.status;
  return (
    <div className="border-b border-dash-border/30 last:border-0">
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-dash-surface-2/50 transition-colors"
        onClick={onToggle}
      >
        <ExpandBtn open={expanded} onClick={onToggle} />
        <Dot status={status} />
        <span className="text-xs text-dash-text truncate flex-1">
          {r.title}
        </span>
        <span
          className={`text-2xs flex-shrink-0 ${STATUS_TEXT[status] ?? "text-dash-text-muted"}`}
        >
          {status}
        </span>
        <span className="text-2xs text-dash-text-muted flex-shrink-0 w-12 text-right">
          {r.taskType === "explicit" ? "plan" : "inferred"}
        </span>
        <span className="text-2xs text-dash-text-dim flex-shrink-0 w-10 text-right font-mono tabular-nums">
          {(r.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-200"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 pt-1 bg-dash-surface/30">
            {task.moduleAffinities.length > 0 && (
              <div className="flex items-center gap-2 mb-1">
                <span className="text-2xs text-dash-text-muted">
                  Module affinity:
                </span>
                {task.moduleAffinities.slice(0, 3).map((ma) => (
                  <span
                    key={ma.moduleKey}
                    className={`text-2xs px-1.5 py-0.5 rounded ${ma.isDominant ? "bg-dash-blue/10 text-dash-blue" : "bg-dash-surface-2 text-dash-text-dim"}`}
                  >
                    {ma.moduleKey}{" "}
                    <span className="opacity-60 font-mono tabular-nums">
                      {(ma.confidence * 100).toFixed(0)}%
                    </span>
                  </span>
                ))}
              </div>
            )}
            {task.groupingBasis.length > 0 && (
              <div className="text-2xs text-dash-text-dim mb-1">
                Grouped by: {task.groupingBasis.join(", ")}
              </div>
            )}
            <div className="text-2xs text-dash-text-dim mb-1">
              {task.sessions.length} session
              {task.sessions.length !== 1 ? "s" : ""} contributing
            </div>
            <EvidencePanel evidence={task.evidence} />
            <BlockerList blockers={task.blockers} />
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkstreamCard({
  ws,
  expanded,
  onToggle,
  expandedTasks,
  onToggleTask,
}: {
  ws: ControlWorkstream;
  expanded: boolean;
  onToggle: () => void;
  expandedTasks: Set<string>;
  onToggleTask: (id: string) => void;
}) {
  const st = ws.state;
  const status = ws.status;

  const sortedTasks = useMemo(() => {
    const order: Record<string, number> = {
      in_progress: 0,
      blocked: 1,
      stalled: 2,
      pending: 3,
      completed: 4,
    };
    return [...ws.tasks].sort(
      (a, b) => (order[a.row.status] ?? 5) - (order[b.row.status] ?? 5),
    );
  }, [ws.tasks]);

  const [showAll, setShowAll] = useState(false);
  const visibleTasks = showAll ? sortedTasks : sortedTasks.slice(0, 15);

  return (
    <div className={`rounded border border-dash-border bg-dash-surface overflow-hidden hover:border-dash-border-light transition-colors ${STATUS_BORDER_L[status] ?? ""}`}>
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-dash-surface-2/50 transition-colors"
        onClick={onToggle}
      >
        <ExpandBtn open={expanded} onClick={onToggle} />
        <Dot status={status} />
        <span className="text-xs text-dash-text font-display font-semibold flex-1 truncate">
          {ws.title}
        </span>
        {st && (
          <div className="flex items-center gap-4 text-2xs flex-shrink-0">
            {st.activeTaskCount > 0 && (
              <span className="text-dash-blue">
                {st.activeTaskCount} active
              </span>
            )}
            {st.blockedTaskCount > 0 && (
              <span className="text-dash-red">
                {st.blockedTaskCount} blocked
              </span>
            )}
            {st.stalledTaskCount > 0 && (
              <span className="text-dash-yellow">
                {st.stalledTaskCount} stalled
              </span>
            )}
            {st.completedTaskCount > 0 && (
              <span className="text-dash-green">
                {st.completedTaskCount} done
              </span>
            )}
            <span className="text-dash-text-muted font-mono tabular-nums">
              {st.sessionCount} sess
            </span>
          </div>
        )}
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-200"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-dash-border">
            {visibleTasks.length === 0 ? (
              <div className="text-2xs text-dash-text-muted px-4 py-3">
                No tasks extracted for this workstream.
              </div>
            ) : (
              <>
                {visibleTasks.map((task) => (
                  <TaskRow
                    key={task.row.id}
                    task={task}
                    expanded={expandedTasks.has(task.row.id)}
                    onToggle={() => onToggleTask(task.row.id)}
                  />
                ))}
                {!showAll && sortedTasks.length > 15 && (
                  <button
                    onClick={() => setShowAll(true)}
                    className="w-full text-center text-2xs text-dash-blue py-2 hover:bg-dash-surface-2/50 transition-colors"
                  >
                    Show all {sortedTasks.length} tasks
                  </button>
                )}
              </>
            )}
            {ws.evidence.length > 0 && (
              <div className="px-4 pb-3 pt-1 border-t border-dash-border/30">
                <EvidencePanel evidence={ws.evidence} max={4} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkstreamsSection({
  control,
  expandedWorkstreams,
  expandedTasks,
  onToggleWorkstream,
  onToggleTask,
}: {
  control: ControlState;
  expandedWorkstreams: Set<string>;
  expandedTasks: Set<string>;
  onToggleWorkstream: (id: string) => void;
  onToggleTask: (id: string) => void;
}) {
  const sorted = useMemo(
    () =>
      [...control.workstreams].sort(
        (a, b) => (b.state?.sessionCount ?? 0) - (a.state?.sessionCount ?? 0),
      ),
    [control.workstreams],
  );

  return (
    <section>
      <SectionHead
        title="Workstreams"
        subtitle="Work grouped by code module based on file touch patterns. Expand to see tasks and evidence."
        count={sorted.length}
      />
      <div className="space-y-2">
        {sorted.map((ws) => (
          <WorkstreamCard
            key={ws.id}
            ws={ws}
            expanded={expandedWorkstreams.has(ws.id)}
            onToggle={() => onToggleWorkstream(ws.id)}
            expandedTasks={expandedTasks}
            onToggleTask={onToggleTask}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section: Sessions
// ---------------------------------------------------------------------------

type SessionTab = "live" | "recent" | "archived";

interface FlatSession {
  session: ControlSession;
  workstreamTitle: string;
}

function SessionCard({
  flat,
  expanded,
  onToggle,
  taskLookup,
}: {
  flat: FlatSession;
  expanded: boolean;
  onToggle: () => void;
  taskLookup: Map<string, ControlTask>;
}) {
  const { session: s, workstreamTitle } = flat;
  const st = s.state;
  const status = st?.status ?? "idle";

  return (
    <div className={`rounded border border-dash-border bg-dash-surface overflow-hidden hover:border-dash-border-light transition-colors ${STATUS_BORDER_L[status] ?? ""}`}>
      <div
        className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-dash-surface-2/50 transition-colors"
        onClick={onToggle}
      >
        <ExpandBtn open={expanded} onClick={onToggle} />
        <Dot status={status} />
        <span className="text-xs text-dash-text-dim font-mono flex-shrink-0">
          {s.row.id.slice(0, 8)}
        </span>
        <span className="text-xs text-dash-text truncate flex-1">
          {st?.currentGoal?.slice(0, 80) || "No goal"}
        </span>
        <span className="text-2xs text-dash-text-muted flex-shrink-0">
          {workstreamTitle}
        </span>
        <span className="text-2xs text-dash-text-dim flex-shrink-0 font-mono">
          {timeAgo(st?.lastEventAt || s.row.lastEventAt)}
        </span>
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-200"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-dash-border px-4 py-3 bg-dash-surface/30 space-y-2">
            {/* Status explanation */}
            <div className="flex items-center gap-2">
              <Dot status={status} />
              <span
                className={`text-2xs ${STATUS_TEXT[status] ?? "text-dash-text-muted"}`}
              >
                {STATUS_LABEL[status] ?? status}
              </span>
            </div>

            {/* Goal and last action */}
            {st && (
              <div className="space-y-1">
                <div className="text-2xs">
                  <span className="text-dash-text-muted">Goal: </span>
                  <span className="text-dash-text">
                    {st.currentGoal.slice(0, 200)}
                  </span>
                </div>
                <div className="text-2xs">
                  <span className="text-dash-text-muted">Last action: </span>
                  <span className="text-dash-text-dim">
                    {st.lastMeaningfulAction.slice(0, 200)}
                  </span>
                </div>
                {st.blockedReason && (
                  <div className="text-2xs text-dash-red/80">
                    Blocked: {st.blockedReason}
                  </div>
                )}
              </div>
            )}

            {/* Session -> Task -> Workstream ladder */}
            {s.tasks.length > 0 && (
              <div className="pl-3 border-l-2 border-dash-blue/20 space-y-1">
                <div className="text-2xs text-dash-text-muted">
                  Contributing to:
                </div>
                {s.tasks.slice(0, 5).map((link) => {
                  const task = taskLookup.get(link.taskId);
                  return (
                    <div key={link.taskId} className="text-2xs flex gap-2">
                      <span className="text-dash-blue">
                        {task?.row.title ?? link.taskId.slice(0, 12)}
                      </span>
                      <span className="text-dash-text-dim font-mono tabular-nums">
                        ({link.relationshipType},{" "}
                        {(link.confidence * 100).toFixed(0)}%)
                      </span>
                    </div>
                  );
                })}
                <div className="text-2xs text-dash-text-dim">
                  in workstream:{" "}
                  <span className="text-dash-text-muted">
                    {workstreamTitle}
                  </span>
                </div>
              </div>
            )}

            {/* Files in play */}
            {s.filesInPlay.length > 0 && (
              <div>
                <div className="text-2xs text-dash-text-muted mb-1">
                  Files in play:
                </div>
                <div className="flex flex-wrap gap-1">
                  {s.filesInPlay.slice(0, 8).map((f) => (
                    <span
                      key={f}
                      className="text-2xs px-1.5 py-0.5 rounded bg-dash-surface-2 text-dash-text-dim font-mono"
                      title={f}
                    >
                      {fileName(f)}
                    </span>
                  ))}
                  {s.filesInPlay.length > 8 && (
                    <span className="text-2xs text-dash-text-muted">
                      +{s.filesInPlay.length - 8}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Handoff */}
            {s.handoff && (
              <div className="pl-3 border-l-2 border-dash-yellow/20">
                <div className="text-2xs text-dash-text-muted mb-0.5">
                  Handoff ({s.handoff.row.handoffType}):
                </div>
                <div className="text-2xs text-dash-text-dim">
                  {s.handoff.row.summary.slice(0, 200)}
                </div>
                {s.handoff.nextSteps.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    <div className="text-2xs text-dash-text-muted">
                      Next steps:
                    </div>
                    {s.handoff.nextSteps.slice(0, 3).map((step, i) => (
                      <div key={i} className="text-2xs text-dash-text-dim">
                        {step.slice(0, 120)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <BlockerList blockers={s.blockers} />

            {s.row.gitBranch && (
              <div className="text-2xs text-dash-text-dim font-mono">
                Branch: {s.row.gitBranch}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionsSection({
  control,
  expandedSessions,
  onToggleSession,
}: {
  control: ControlState;
  expandedSessions: Set<string>;
  onToggleSession: (id: string) => void;
}) {
  const [tab, setTab] = useState<SessionTab>("live");
  const [showCount, setShowCount] = useState(20);

  const { grouped, taskLookup } = useMemo(() => {
    const sessionMap = new Map<string, FlatSession>();
    const tLookup = new Map<string, ControlTask>();

    for (const ws of control.workstreams) {
      for (const task of ws.tasks) {
        tLookup.set(task.row.id, task);
      }
      for (const session of ws.sessions) {
        if (!sessionMap.has(session.row.id)) {
          sessionMap.set(session.row.id, {
            session,
            workstreamTitle: ws.title,
          });
        }
      }
    }

    const all = Array.from(sessionMap.values());
    const live: FlatSession[] = [];
    const recent: FlatSession[] = [];
    const archived: FlatSession[] = [];

    for (const f of all) {
      const r = sessionRecency(f.session);
      if (r === "live") live.push(f);
      else if (r === "recent") recent.push(f);
      else archived.push(f);
    }

    const byRecent = (a: FlatSession, b: FlatSession) => {
      const at =
        a.session.state?.lastEventAt || a.session.row.lastEventAt || "";
      const bt =
        b.session.state?.lastEventAt || b.session.row.lastEventAt || "";
      return bt.localeCompare(at);
    };
    live.sort(byRecent);
    recent.sort(byRecent);
    archived.sort(byRecent);

    return { grouped: { live, recent, archived }, taskLookup: tLookup };
  }, [control]);

  const tabs: Array<{ key: SessionTab; label: string; count: number }> = [
    { key: "live", label: "Live", count: grouped.live.length },
    { key: "recent", label: "Recent", count: grouped.recent.length },
    { key: "archived", label: "Archived", count: grouped.archived.length },
  ];

  const visible = grouped[tab];
  const displayed = visible.slice(0, showCount);

  return (
    <section>
      <SectionHead
        title="Sessions"
        subtitle="Individual Claude Code conversations. Live = active in last 10m. Recent = last 24h. Archived = older."
      />

      {/* Status legend */}
      <div className="flex flex-wrap gap-4 mb-3">
        {Object.entries(STATUS_LABEL).map(([key, label]) => (
          <div key={key} className="flex items-center gap-1.5">
            <Dot status={key} />
            <span className="text-2xs text-dash-text-dim">{label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-dash-border mb-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setShowCount(20);
            }}
            className={`relative px-3 py-2 text-2xs uppercase tracking-[1px] font-semibold transition-colors ${
              tab === t.key
                ? "text-dash-text"
                : "text-dash-text-muted hover:text-dash-text"
            }`}
          >
            {t.label}{" "}
            <span className="text-dash-text-dim font-mono tabular-nums">{t.count}</span>
            {tab === t.key && (
              <span className="absolute bottom-0 left-0 right-0 h-px bg-dash-blue" />
            )}
          </button>
        ))}
      </div>

      {displayed.length === 0 ? (
        <div className="text-2xs text-dash-text-muted py-6 text-center border border-dash-border rounded">
          No {tab} sessions.
        </div>
      ) : (
        <div className="space-y-1.5">
          {displayed.map((f) => (
            <SessionCard
              key={f.session.row.id}
              flat={f}
              expanded={expandedSessions.has(f.session.row.id)}
              onToggle={() => onToggleSession(f.session.row.id)}
              taskLookup={taskLookup}
            />
          ))}
          {visible.length > showCount && (
            <button
              onClick={() => setShowCount((c) => c + 20)}
              className="w-full text-center text-2xs text-dash-blue py-2 rounded border border-dash-border hover:bg-dash-surface transition-colors"
            >
              Show more ({visible.length - showCount} remaining)
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section: Activity
// ---------------------------------------------------------------------------

function DailyChart({
  title,
  data,
  valueKey,
  color,
}: {
  title: string;
  data: AnalyticsState["activity"]["daily"];
  valueKey: "turns" | "sessions" | "outputTokens";
  color: string;
}) {
  const values = data.map((d) => d[valueKey]);
  const max = Math.max(1, ...values);
  const total = values.reduce((s, v) => s + v, 0);

  return (
    <div className="rounded border border-dash-border bg-dash-surface px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xs text-dash-text-muted font-semibold uppercase tracking-[1px]">{title}</span>
        <span className="text-2xs text-dash-text-dim font-mono tabular-nums">
          {fmt(total)} total
        </span>
      </div>
      <div className="flex items-end gap-px h-16">
        {data.map((d) => {
          const h = (d[valueKey] / max) * 100;
          return (
            <div
              key={d.day}
              className="flex-1 min-w-0 flex flex-col items-center group"
              title={`${d.day}: ${d[valueKey].toLocaleString()}`}
            >
              <div className="w-full flex items-end justify-center h-12">
                <div
                  className="w-full max-w-[12px] rounded-t opacity-70 group-hover:opacity-100 transition-opacity"
                  style={{
                    height: `${Math.max(h, 2)}%`,
                    background: `linear-gradient(to top, ${color}, ${color}cc)`,
                  }}
                />
              </div>
              {data.length <= 15 && (
                <div className="text-[8px] text-dash-text-dim mt-1 truncate w-full text-center font-mono">
                  {d.day.slice(5)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActivitySection({ analytics }: { analytics: AnalyticsState }) {
  const { daily, recentCommits, recentDecisions } = analytics.activity;

  return (
    <section>
      <SectionHead
        title="Activity"
        subtitle="Daily usage patterns and recent events across all sessions"
      />

      {daily.length > 0 && (
        <div className="space-y-3 mb-6">
          <DailyChart
            title="Turns / Day"
            data={daily}
            valueKey="turns"
            color="var(--dash-blue)"
          />
          <div className="grid grid-cols-2 gap-3">
            <DailyChart
              title="Sessions / Day"
              data={daily}
              valueKey="sessions"
              color="var(--dash-green)"
            />
            <DailyChart
              title="Output Tokens / Day"
              data={daily}
              valueKey="outputTokens"
              color="var(--dash-purple)"
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        <div>
          <h3 className="text-2xs text-dash-text-muted uppercase tracking-[1px] font-semibold mb-2">
            Recent Commits ({recentCommits.length})
          </h3>
          {recentCommits.length === 0 ? (
            <div className="text-2xs text-dash-text-muted py-4 text-center border border-dash-border rounded">
              No commits recorded.
            </div>
          ) : (
            <div className="space-y-1">
              {recentCommits.map((c, i) => (
                <div
                  key={c.sha ?? i}
                  className="flex items-start gap-2 rounded border border-dash-border bg-dash-surface px-3 py-2 hover:bg-dash-surface-2/50 transition-colors"
                >
                  <span className="text-2xs text-dash-green font-mono flex-shrink-0 mt-0.5">
                    {c.sha?.slice(0, 7) ?? "-------"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-2xs text-dash-text truncate">
                      {c.message || "(no message)"}
                    </div>
                    <div className="text-2xs text-dash-text-dim font-mono">
                      {timeAgo(c.timestamp)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-2xs text-dash-text-muted uppercase tracking-[1px] font-semibold mb-2">
            Recent Decisions ({recentDecisions.length})
          </h3>
          {recentDecisions.length === 0 ? (
            <div className="text-2xs text-dash-text-muted py-4 text-center border border-dash-border rounded">
              No decisions recorded.
            </div>
          ) : (
            <div className="space-y-1">
              {recentDecisions.map((d, i) => (
                <div
                  key={i}
                  className="rounded border border-dash-border bg-dash-surface px-3 py-2 hover:bg-dash-surface-2/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-2xs text-dash-text truncate">
                      {d.title}
                    </span>
                    <span className="text-2xs text-dash-green flex-shrink-0">
                      {d.status}
                    </span>
                  </div>
                  {d.summary && (
                    <div className="text-2xs text-dash-text-dim mt-0.5 truncate">
                      {d.summary}
                    </div>
                  )}
                  {d.decidedAt && (
                    <div className="text-2xs text-dash-text-muted mt-0.5 font-mono">
                      {timeAgo(d.decidedAt)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section: Files
// ---------------------------------------------------------------------------

function FilesSection({ analytics }: { analytics: AnalyticsState }) {
  const { modules, topFiles } = analytics.fileHeatmap;
  const maxTouches = Math.max(1, ...modules.map((m) => m.touchCount));
  const maxWrites = Math.max(1, ...topFiles.map((f) => f.writes));

  return (
    <section>
      <SectionHead
        title="Files"
        subtitle="Which code modules and files are being touched most. Write-heavy files carry more churn risk."
        count={topFiles.length}
      />

      {modules.length > 0 && (
        <div className="mb-4">
          <h3 className="text-2xs text-dash-text-muted uppercase tracking-[1px] font-semibold mb-2">
            Modules
          </h3>
          <div className="grid grid-cols-4 gap-1.5">
            {modules.map((m) => {
              const intensity = m.touchCount / maxTouches;
              return (
                <div
                  key={m.moduleKey}
                  className="rounded border border-dash-border px-3 py-2 hover:shadow-soft hover:border-dash-blue/40 transition-all"
                  style={{
                    backgroundColor: `rgba(77, 159, 255, ${0.03 + intensity * 0.15})`,
                  }}
                  title={`${m.moduleKey}\n${m.touchCount} touches, ${m.writeCount} writes, ${m.readCount} reads\n${m.sessionCount} sessions`}
                >
                  <div className="text-xs text-dash-text font-medium truncate">
                    {m.moduleKey}
                  </div>
                  <div className="text-2xs text-dash-text-muted mt-0.5 font-mono tabular-nums">
                    {m.touchCount} touches &middot; {m.writeCount}W{" "}
                    {m.readCount}R
                  </div>
                  <div className="text-2xs text-dash-text-dim font-mono tabular-nums">
                    {m.sessionCount} session
                    {m.sessionCount !== 1 ? "s" : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {topFiles.length > 0 && (
        <div>
          <h3 className="text-2xs text-dash-text-muted uppercase tracking-[1px] font-semibold mb-2">
            Top Files by Writes
          </h3>
          <div className="rounded border border-dash-border overflow-hidden">
            <table className="w-full text-2xs">
              <thead>
                <tr className="bg-dash-bg text-dash-text-muted border-b border-dash-border">
                  <th className="text-left px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">File</th>
                  <th className="text-left px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">
                    Module
                  </th>
                  <th className="text-right px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">
                    Writes
                  </th>
                  <th className="text-right px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">
                    Reads
                  </th>
                  <th className="text-right px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">
                    Sessions
                  </th>
                  <th className="text-left px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px] w-24">
                    Intensity
                  </th>
                </tr>
              </thead>
              <tbody>
                {topFiles.slice(0, 20).map((f) => (
                  <tr
                    key={f.filePath}
                    className="border-b border-dash-border/50 last:border-0 hover:bg-dash-surface-2/50 transition-colors even:bg-dash-surface/50"
                  >
                    <td
                      className="px-3 py-1.5 text-dash-text truncate max-w-[280px] font-mono"
                      title={f.filePath}
                    >
                      <span className="text-dash-text">
                        {fileName(f.filePath)}
                      </span>
                      <span className="text-dash-text-dim ml-1">
                        {shortPath(
                          f.filePath.split("/").slice(0, -1).join("/"),
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-dash-text-muted">
                      {f.moduleKey || "\u2014"}
                    </td>
                    <td className="px-3 py-1.5 text-right text-dash-text font-mono tabular-nums">
                      {f.writes}
                    </td>
                    <td className="px-3 py-1.5 text-right text-dash-text-dim font-mono tabular-nums">
                      {f.reads}
                    </td>
                    <td className="px-3 py-1.5 text-right text-dash-text-dim font-mono tabular-nums">
                      {f.sessionCount}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="h-1.5 bg-dash-surface-2 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-dash-blue rounded-full"
                          style={{
                            width: `${(f.writes / maxWrites) * 100}%`,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section: Cost
// ---------------------------------------------------------------------------

function CostSection({ analytics }: { analytics: AnalyticsState }) {
  const { totals, byWorkstream } = analytics.cost;
  const totalInput = totals.inputTokens + totals.cacheReadTokens;
  const cacheHitPct =
    totalInput > 0
      ? ((totals.cacheReadTokens / totalInput) * 100).toFixed(1)
      : "0.0";
  const maxOutput = Math.max(1, ...byWorkstream.map((w) => w.outputTokens));

  return (
    <section>
      <SectionHead
        title="Cost"
        subtitle="Token usage across workstreams. Output tokens are the primary cost driver."
      />

      <div className="grid grid-cols-4 gap-3 mb-4">
        <StatBox label="Output Tokens" value={fmt(totals.outputTokens)} accent="var(--dash-purple)" />
        <StatBox label="Input Tokens" value={fmt(totals.inputTokens)} accent="var(--dash-blue)" />
        <StatBox label="Cache Reads" value={fmt(totals.cacheReadTokens)} accent="var(--dash-green)" />
        <StatBox label="Cache Hit %" value={`${cacheHitPct}%`} accent="var(--dash-green)" />
      </div>

      <div className="text-2xs text-dash-text-muted mb-4 font-mono tabular-nums">
        {fmt(totals.turns)} turns across {totals.sessions} sessions
      </div>

      {byWorkstream.length > 0 && (
        <div className="rounded border border-dash-border overflow-hidden">
          <table className="w-full text-2xs">
            <thead>
              <tr className="bg-dash-bg text-dash-text-muted border-b border-dash-border">
                <th className="text-left px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">
                  Workstream
                </th>
                <th className="text-right px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">Turns</th>
                <th className="text-right px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">
                  Sessions
                </th>
                <th className="text-right px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">Output</th>
                <th className="text-right px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">Input</th>
                <th className="text-right px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px]">Cache</th>
                <th className="text-left px-3 py-1.5 text-2xs font-semibold uppercase tracking-[1px] w-28">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {byWorkstream.map((w) => (
                <tr
                  key={w.workstreamTitle}
                  className="border-b border-dash-border/50 last:border-0 hover:bg-dash-surface-2/50 transition-colors even:bg-dash-surface/50"
                >
                  <td className="px-3 py-1.5 text-dash-text truncate max-w-[200px]">
                    {w.workstreamTitle}
                  </td>
                  <td className="px-3 py-1.5 text-right text-dash-text-dim font-mono tabular-nums">
                    {fmt(w.turns)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-dash-text-dim font-mono tabular-nums">
                    {w.sessions}
                  </td>
                  <td className="px-3 py-1.5 text-right text-dash-text font-mono tabular-nums">
                    {fmt(w.outputTokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-dash-text-dim font-mono tabular-nums">
                    {fmt(w.inputTokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-dash-text-dim font-mono tabular-nums">
                    {fmt(w.cacheReadTokens)}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="h-1.5 bg-dash-surface-2 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-dash-purple rounded-full"
                        style={{
                          width: `${(w.outputTokens / maxOutput) * 100}%`,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export default function ControlPage() {
  const [analytics, setAnalytics] = useState<AnalyticsState | null>(null);
  const [control, setControl] = useState<ControlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expandedWorkstreams, setExpandedWorkstreams] = useState<Set<string>>(
    new Set(),
  );
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(
    new Set(),
  );

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [a, c] = await Promise.all([
          getAnalyticsState(),
          getControlState(),
        ]);
        if (cancelled) return;
        setAnalytics(a);
        setControl(c);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (loading && (!analytics || !control)) {
    return (
      <div className="h-screen bg-dash-bg flex items-center justify-center text-dash-text-muted text-sm">
        Loading control plane...
      </div>
    );
  }

  if (error && (!analytics || !control)) {
    return (
      <div className="h-screen bg-dash-bg flex items-center justify-center text-dash-red text-sm">
        {error}
      </div>
    );
  }

  if (!analytics || !control) return null;

  return (
    <div className="min-h-screen bg-dash-bg text-dash-text font-sans text-xs leading-relaxed">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-dash-bg/95 backdrop-blur px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm font-display font-bold text-dash-green tracking-wide">
              HEXDECK
            </span>
            <span className="text-2xs uppercase tracking-widest font-semibold text-dash-text-muted">
              control plane
            </span>
          </div>
          <div className="flex items-center gap-3">
            {error && (
              <span className="text-2xs text-dash-red">{error}</span>
            )}
            <span className="text-2xs text-dash-text-dim font-mono">
              updated {timeAgo(analytics.generatedAt)}
            </span>
          </div>
        </div>
        <div className="h-px bg-gradient-to-r from-transparent via-dash-green/30 to-transparent mt-3" />
      </div>

      {/* Scrollable content */}
      <div className="max-w-[1200px] mx-auto px-6 py-6 space-y-10">
        <CountersSection analytics={analytics} control={control} />

        <WorkstreamsSection
          control={control}
          expandedWorkstreams={expandedWorkstreams}
          expandedTasks={expandedTasks}
          onToggleWorkstream={(id) =>
            setExpandedWorkstreams((s) => toggle(s, id))
          }
          onToggleTask={(id) => setExpandedTasks((s) => toggle(s, id))}
        />

        <SessionsSection
          control={control}
          expandedSessions={expandedSessions}
          onToggleSession={(id) =>
            setExpandedSessions((s) => toggle(s, id))
          }
        />

        <ActivitySection analytics={analytics} />
        <FilesSection analytics={analytics} />
        <CostSection analytics={analytics} />
      </div>
    </div>
  );
}

"use client";

import type { TaskHandoff } from "../context-map/types";

interface TaskHandoffDrawerProps {
  handoff: TaskHandoff;
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  active: "bg-[#2a2a1a] text-dash-yellow",
  completed: "bg-[#1a2a1a] text-dash-green",
  blocked: "bg-[#2a1a1a] text-dash-red",
  handoff_ready: "bg-[#1a1a2a] text-dash-purple",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3.5">
      <div className="text-[9px] text-dash-text-muted uppercase tracking-widest mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

export function TaskHandoffDrawer({ handoff, onClose }: TaskHandoffDrawerProps) {
  return (
    <div className="w-[260px] shrink-0 border-l border-dash-border bg-[#0d0d11] p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-dash-yellow uppercase tracking-widest font-semibold">
          Task Handoff
        </span>
        <button
          onClick={onClose}
          className="text-dash-text-muted hover:text-dash-text text-[10px] cursor-pointer"
        >
          ✕
        </button>
      </div>

      {/* Task info */}
      <div className="mb-3.5">
        <div className="text-xs text-dash-text font-semibold mb-1">{handoff.subject}</div>
        <div className="flex gap-1.5">
          <span className={`text-2xs px-1.5 py-0.5 rounded ${statusColors[handoff.status] ?? ""}`}>
            {handoff.status.replace("_", " ")}
          </span>
        </div>
      </div>

      {/* History */}
      <Section title="History">
        {handoff.history.length === 0 ? (
          <div className="text-[10px] text-dash-text-muted">—</div>
        ) : (
          <div className="text-[10px] text-dash-text-dim pl-2 border-l border-[#333] space-y-1">
            {handoff.history.map((h, i) => (
              <div key={i}>{h}</div>
            ))}
          </div>
        )}
      </Section>

      {/* Key Knowledge */}
      <Section title="Key Knowledge">
        {handoff.knowledge.length === 0 ? (
          <div className="text-[10px] text-dash-text-muted">—</div>
        ) : (
          <div className="text-[10px] text-dash-text-dim space-y-0.5">
            {handoff.knowledge.map((k, i) => (
              <div key={i}>• {k}</div>
            ))}
          </div>
        )}
      </Section>

      {/* Open State */}
      <Section title="Open">
        {handoff.blockers.length === 0 ? (
          <div className="text-[10px] text-dash-text-muted">—</div>
        ) : (
          <div className="text-[10px] text-dash-red space-y-0.5">
            {handoff.blockers.map((b, i) => (
              <div key={i}>• {b}</div>
            ))}
          </div>
        )}
      </Section>

      {/* Next Step */}
      <Section title="Next Step">
        {handoff.nextStep ? (
          <div className="text-[10px] text-dash-green">{handoff.nextStep}</div>
        ) : (
          <div className="text-[10px] text-dash-text-muted">—</div>
        )}
      </Section>
    </div>
  );
}

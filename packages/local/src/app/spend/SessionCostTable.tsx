import { useState, useMemo } from "react";
import type { SessionListResult } from "@/lib/metrics-api";
import { formatCost, formatDuration } from "@/lib/format";

const PAGE_SIZE = 20;

interface SessionCostTableProps {
  sessions: SessionListResult | null;
  onSelectSession?: (sessionId: string) => void;
}

export function SessionCostTable({ sessions, onSelectSession }: SessionCostTableProps) {
  const [showCount, setShowCount] = useState(PAGE_SIZE);

  const rows = useMemo(() => {
    if (!sessions) return [];
    return sessions.sessions;
  }, [sessions]);

  const visible = rows.slice(0, showCount);

  if (rows.length === 0) {
    return (
      <div className="text-xs text-dash-text-muted py-4">
        No sessions in this period
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-semibold text-dash-text uppercase tracking-wider mb-2">
        Sessions
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-2xs">
          <thead>
            <tr className="text-dash-text-muted text-left">
              <th className="pb-1.5 pr-3 font-medium">Session</th>
              <th className="pb-1.5 pr-3 font-medium text-right">~Cost</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Duration</th>
              <th className="pb-1.5 font-medium text-right">Turns</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr
                key={s.sessionId}
                className="border-t border-dash-border/50 hover:bg-dash-surface/50 cursor-default"
                onClick={() => onSelectSession?.(s.sessionId)}
              >
                <td className="py-1.5 pr-3 text-dash-text truncate max-w-[180px]">
                  {projectBasename(s.projectPath)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-dash-text font-mono">
                  ~{formatCost(s.totalCostUsd)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-dash-text-muted font-mono">
                  {formatDuration(s.durationMs)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-dash-text-muted">
                  {s.totalTurns}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > showCount && (
        <button
          onClick={() => setShowCount((c) => c + PAGE_SIZE)}
          className="mt-2 text-2xs text-dash-text-muted hover:text-dash-text transition-colors"
        >
          Show more ({rows.length - showCount} remaining)
        </button>
      )}
    </div>
  );
}

function projectBasename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

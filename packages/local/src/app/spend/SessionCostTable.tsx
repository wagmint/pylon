import { useState, useMemo } from "react";
import type { SessionListResult } from "@/lib/metrics-api";
import { formatCost } from "@/lib/format";

const PAGE_SIZE = 20;

interface BranchGroup {
  branch: string;
  totalCost: number;
  sessionCount: number;
  totalTurns: number;
}

interface SessionCostTableProps {
  sessions: SessionListResult | null;
  onSelectSession?: (sessionId: string) => void;
}

export function SessionCostTable({ sessions }: SessionCostTableProps) {
  const [showCount, setShowCount] = useState(PAGE_SIZE);

  const groups = useMemo(() => {
    if (!sessions) return [];
    const map = new Map<string, BranchGroup>();
    for (const s of sessions.sessions) {
      const branch = s.gitBranch ?? projectBasename(s.projectPath);
      const existing = map.get(branch);
      if (existing) {
        existing.totalCost += s.totalCostUsd;
        existing.sessionCount += 1;
        existing.totalTurns += s.totalTurns;
      } else {
        map.set(branch, {
          branch,
          totalCost: s.totalCostUsd,
          sessionCount: 1,
          totalTurns: s.totalTurns,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.totalCost - a.totalCost);
  }, [sessions]);

  const visible = groups.slice(0, showCount);

  if (groups.length === 0) {
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
              <th className="pb-1.5 pr-3 font-medium">Branch</th>
              <th className="pb-1.5 pr-3 font-medium text-right">~Cost</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Sessions</th>
              <th className="pb-1.5 font-medium text-right">Turns</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((g) => (
              <tr
                key={g.branch}
                className="border-t border-dash-border/50"
              >
                <td className="py-1.5 pr-3 text-dash-text truncate max-w-[180px]">
                  {g.branch}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-dash-text font-mono">
                  ~{formatCost(g.totalCost)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-dash-text-muted">
                  {g.sessionCount}
                </td>
                <td className="py-1.5 text-right tabular-nums text-dash-text-muted">
                  {g.totalTurns}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {groups.length > showCount && (
        <button
          onClick={() => setShowCount((c) => c + PAGE_SIZE)}
          className="mt-2 text-2xs text-dash-text-muted hover:text-dash-text transition-colors"
        >
          Show more ({groups.length - showCount} remaining)
        </button>
      )}
    </div>
  );
}

function projectBasename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

import type { Period } from "@/hooks/useSpendMetrics";
import type { SessionListResult } from "@/lib/metrics-api";
import type { DashboardState } from "@hexdeck/dashboard-ui";
import { formatCost, formatNumber } from "@/lib/format";

const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
];

interface SpendHeadlineProps {
  period: Period;
  onPeriodChange: (p: Period) => void;
  sessions: SessionListResult | null;
  state: DashboardState;
}

export function SpendHeadline({ period, onPeriodChange, sessions, state }: SpendHeadlineProps) {
  const totalCost = sessions?.sessions.reduce((sum, s) => sum + s.totalCostUsd, 0) ?? 0;
  const totalSessions = sessions?.total ?? 0;
  const totalTurns = sessions?.sessions.reduce((sum, s) => sum + s.totalTurns, 0) ?? 0;

  const { activeAgents, totalTokens, totalCost: liveCost } = state.summary;

  return (
    <div>
      {/* Period tabs */}
      <div className="flex items-center gap-4 mb-4">
        {PERIODS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onPeriodChange(key)}
            className={`text-xs pb-1 transition-colors ${
              period === key
                ? "text-dash-text border-b-2 border-dash-green"
                : "text-dash-text-muted hover:text-dash-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Primary: token count */}
      <div className="text-2xl font-semibold font-mono tabular-nums text-dash-text">
        {formatNumber(totalTokens)} tokens
      </div>

      {/* Secondary: approximate cost */}
      <div className="text-xs text-dash-text-muted mt-1 group relative inline-block">
        ~{formatCost(totalCost)} at list price
        <span className="hidden group-hover:block absolute left-0 top-full mt-1 z-10 bg-dash-surface-2 border border-dash-border rounded px-2 py-1 text-2xs text-dash-text-dim w-52">
          Actual costs depend on your organization&apos;s contract with the provider
        </span>
      </div>

      {/* Tertiary: session/turn count */}
      <div className="text-xs text-dash-text-dim mt-0.5">
        {totalSessions} session{totalSessions !== 1 ? "s" : ""} · {totalTurns} turns
      </div>

      {/* Live indicator */}
      {activeAgents > 0 && (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-dash-green">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-dash-green animate-pulse" />
          {activeAgents} active · ~{formatCost(liveCost)} live
        </div>
      )}
    </div>
  );
}

"use client";

import type { DashboardState } from "@hexdeck/dashboard-ui";
import type { Period, SpendMetrics } from "@/hooks/useSpendMetrics";
import { SpendHeadline } from "./spend/SpendHeadline";
import { TrendSparkline } from "./spend/TrendSparkline";
import { ModelBreakdownBars } from "./spend/ModelBreakdownBars";
import { SessionCostTable } from "./spend/SessionCostTable";

interface MeSpendViewProps {
  state: DashboardState;
  period: Period;
  onPeriodChange: (p: Period) => void;
  spendMetrics: SpendMetrics;
}

export function MeSpendView({ state, period, onPeriodChange, spendMetrics }: MeSpendViewProps) {
  const { sessions, spend, trends, loading } = spendMetrics;

  return (
    <div className="relative h-full overflow-y-auto scrollbar-thin">
      {/* Loading bar — visible on period change even with stale data */}
      {loading && (
        <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden z-10">
          <div className="h-full w-2/5 bg-dash-green rounded-full animate-loading-slide" />
        </div>
      )}

      <div className="p-6 space-y-6">
      <SpendHeadline
        period={period}
        onPeriodChange={onPeriodChange}
        sessions={sessions}
        state={state}
      />

      <TrendSparkline trends={trends} />

      <ModelBreakdownBars spend={spend} />

      <SessionCostTable sessions={sessions} />
      </div>
    </div>
  );
}

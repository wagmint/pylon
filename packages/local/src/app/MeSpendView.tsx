"use client";

import { useState } from "react";
import type { DashboardState } from "@hexdeck/dashboard-ui";
import { useSpendMetrics, type Period } from "@/hooks/useSpendMetrics";
import { SpendHeadline } from "./spend/SpendHeadline";
import { TrendSparkline } from "./spend/TrendSparkline";
import { ModelBreakdownBars } from "./spend/ModelBreakdownBars";
import { SessionCostTable } from "./spend/SessionCostTable";

interface MeSpendViewProps {
  state: DashboardState;
}

export function MeSpendView({ state }: MeSpendViewProps) {
  const [period, setPeriod] = useState<Period>("week");
  const { sessions, spend, trends, loading } = useSpendMetrics(period);

  return (
    <div
      className="h-full overflow-y-auto scrollbar-thin p-6 space-y-6 transition-opacity duration-200"
      style={{ opacity: loading && !sessions ? 0.5 : 1 }}
    >
      <SpendHeadline
        period={period}
        onPeriodChange={setPeriod}
        sessions={sessions}
        state={state}
      />

      <TrendSparkline trends={trends} />

      <ModelBreakdownBars spend={spend} />

      <SessionCostTable sessions={sessions} />
    </div>
  );
}

import type { SpendResult } from "@/lib/metrics-api";
import { shortModelName, formatCost } from "@/lib/format";

interface ModelBreakdownBarsProps {
  spend: SpendResult | null;
}

export function ModelBreakdownBars({ spend }: ModelBreakdownBarsProps) {
  if (!spend || spend.buckets.length === 0) return null;

  const totalCost = spend.buckets.reduce((sum, b) => sum + b.costUsd, 0);
  if (totalCost <= 0) return null;

  return (
    <div>
      <h3 className="text-xs font-semibold text-dash-text uppercase tracking-wider mb-2">
        By Model
      </h3>
      <div className="space-y-1.5">
        {spend.buckets.map((bucket) => {
          const pct = bucket.costUsd / totalCost;
          return (
            <div key={bucket.key} className="flex items-center gap-2">
              <span
                className="text-2xs text-dash-text-muted w-20 shrink-0 truncate"
                title={bucket.key}
              >
                {shortModelName(bucket.key)}
              </span>
              <div className="flex-1 h-1.5 bg-dash-surface-3 rounded-sm overflow-hidden">
                <div
                  className="h-full rounded-sm bg-dash-blue"
                  style={{ width: `${Math.round(pct * 100)}%` }}
                />
              </div>
              <span className="text-2xs text-dash-text-dim w-14 text-right tabular-nums">
                ~{formatCost(bucket.costUsd)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

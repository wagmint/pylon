import type { TrendResult } from "@/lib/metrics-api";

interface TrendSparklineProps {
  trends: TrendResult | null;
}

export function TrendSparkline({ trends }: TrendSparklineProps) {
  if (!trends || trends.points.length === 0) return null;

  const points = trends.points.slice(-14);
  const max = Math.max(...points.map((p) => p.value), 0.01);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <h3 className="text-xs font-semibold text-dash-text uppercase tracking-wider mb-2">
        Daily Spend (14d)
      </h3>
      <div className="flex items-end gap-px h-16">
        {points.map((p) => {
          const height = Math.max((p.value / max) * 100, 2);
          const isToday = p.bucketStart === today;
          return (
            <div
              key={p.bucketStart}
              className="flex-1 min-w-0 group relative"
              style={{ height: "100%" }}
            >
              <div
                className={`w-full rounded-t-sm absolute bottom-0 ${
                  isToday ? "bg-dash-green" : "bg-dash-blue"
                }`}
                style={{ height: `${height}%` }}
              />
              <div className="hidden group-hover:block absolute -top-6 left-1/2 -translate-x-1/2 text-2xs text-dash-text bg-dash-surface-2 px-1 py-0.5 rounded whitespace-nowrap z-10">
                ${p.value.toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import type { LocalPlanCollision } from "../types";

const confidenceClass: Record<LocalPlanCollision["confidence"], string> = {
  high: "text-dash-red border-dash-red/30 bg-dash-red/10",
  medium: "text-dash-yellow border-dash-yellow/30 bg-dash-yellow/10",
  low: "text-dash-text border-dash-border bg-dash-surface-2",
};

export function ConfidenceBadge({ confidence }: { confidence: LocalPlanCollision["confidence"] }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-xl border px-2 py-1 text-2xs font-semibold ${confidenceClass[confidence]}`}
    >
      <span className="inline-flex items-end gap-[2px] h-3">
        <span className="w-[3px] h-[6px] rounded-[2px] bg-current opacity-60" />
        <span className="w-[3px] h-[9px] rounded-[2px] bg-current opacity-75" />
        <span className="w-[3px] h-[12px] rounded-[2px] bg-current" />
      </span>
      <span className="capitalize">{confidence} confidence</span>
    </span>
  );
}

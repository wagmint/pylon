"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

interface GoalNodeData {
  label: string;
  [key: string]: unknown;
}

export function ContextNodeGoal({ data }: NodeProps) {
  const { label } = data as GoalNodeData;
  return (
    <div className="bg-dash-surface border border-dash-blue rounded-md px-4 py-2 text-center min-w-[160px]">
      <div className="text-2xs text-dash-blue uppercase tracking-widest mb-0.5">
        Goal
      </div>
      <div className="text-xs text-dash-text font-medium truncate">{label}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-dash-blue !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}

"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { TaskStatus } from "../context-map/types";

interface TaskNodeData {
  label: string;
  status: TaskStatus;
  sessionCount: number;
  selected: boolean;
  [key: string]: unknown;
}

const statusColors: Record<TaskStatus, { border: string; text: string; dot: string }> = {
  active: { border: "border-dash-yellow", text: "text-dash-yellow", dot: "bg-dash-yellow" },
  completed: { border: "border-dash-green", text: "text-dash-green", dot: "bg-dash-green" },
  blocked: { border: "border-dash-red", text: "text-dash-red", dot: "bg-dash-red" },
  handoff_ready: { border: "border-dash-purple", text: "text-dash-purple", dot: "bg-dash-purple" },
};

export function ContextNodeTask({ data }: NodeProps) {
  const { label, status, sessionCount, selected } = data as TaskNodeData;
  const colors = statusColors[status] ?? statusColors.active;

  return (
    <div
      className={`bg-dash-surface ${colors.border} rounded-md px-3 py-2 min-w-[130px] cursor-pointer transition-shadow ${
        selected ? "border-2 shadow-[0_0_12px_rgba(255,196,77,0.15)]" : "border"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-dash-border !w-1.5 !h-1.5 !border-0" />
      <div className="flex items-center gap-1 mb-0.5">
        <span className={`w-1.5 h-1.5 rounded-full ${colors.dot} shrink-0`} />
        <span className={`text-2xs ${colors.text} uppercase`}>{status.replace("_", " ")}</span>
      </div>
      <div className="text-[10px] text-dash-text truncate">{label}</div>
      {sessionCount > 0 && (
        <div className="text-2xs text-dash-text-muted mt-0.5">
          {sessionCount} session{sessionCount !== 1 ? "s" : ""}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-dash-border !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}

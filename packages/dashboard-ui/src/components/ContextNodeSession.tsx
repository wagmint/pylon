"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { AgentType, AgentStatus } from "../types";

interface SessionNodeData {
  label: string;
  agentType: AgentType;
  agentStatus: AgentStatus;
  [key: string]: unknown;
}

export function ContextNodeSession({ data }: NodeProps) {
  const { label, agentType, agentStatus } = data as SessionNodeData;
  return (
    <div className="bg-[#111118] border border-[#333] rounded px-2.5 py-1.5 min-w-[90px]">
      <Handle type="target" position={Position.Top} className="!bg-[#333] !w-1 !h-1 !border-0" />
      <div className="text-[9px] text-dash-text-dim truncate">{label}</div>
      <div className="text-2xs text-dash-text-muted">
        {agentType} · {agentStatus}
      </div>
    </div>
  );
}

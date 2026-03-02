"use client";

import type { AgentStatus } from "../types";

interface AgentPipProps {
  status: AgentStatus;
  onClick?: () => void;
}

const statusConfig: Record<AgentStatus, {
  bg: string;
  border: string;
  text: string;
  icon: string;
  animation?: string;
}> = {
  idle: {
    bg: "bg-dash-surface-2",
    border: "border-dash-text-muted",
    text: "text-dash-text-muted",
    icon: "\u2713",
  },
  busy: {
    bg: "bg-dash-green-dim",
    border: "border-dash-green",
    text: "text-dash-green",
    icon: "\u25B6",
    animation: "animate-dash-pulse",
  },
  warning: {
    bg: "bg-dash-yellow-dim",
    border: "border-dash-yellow",
    text: "text-dash-yellow",
    icon: "\u26A0",
  },
  conflict: {
    bg: "bg-dash-red-dim",
    border: "border-dash-red",
    text: "text-dash-red",
    icon: "!",
    animation: "animate-conflict-flash",
  },
  blocked: {
    bg: "bg-dash-blue-dim",
    border: "border-dash-blue",
    text: "text-dash-blue",
    icon: "\u23F8",
    animation: "animate-dash-breathe",
  },
};

export function AgentPip({ status, onClick }: AgentPipProps) {
  const config = statusConfig[status];
  return (
    <div
      onClick={onClick}
      className={`w-3.5 h-3.5 shrink-0 rounded-sm ${config.bg} border ${config.border} flex items-center justify-center text-[7px] font-semibold ${config.text} ${config.animation ?? ""} ${onClick ? "cursor-pointer" : ""}`}
    >
      {config.icon}
    </div>
  );
}

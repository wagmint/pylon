"use client";

import type { FeedEvent } from "../types";
import { useOperators } from "./OperatorContext";
import { timeAgo } from "../utils";

interface FeedItemProps {
  event: FeedEvent;
  isNew?: boolean;
  onClick?: () => void;
  onDecide?: (sessionId: string, action: "approve" | "deny") => void;
}

const typeConfig: Record<
  FeedEvent["type"],
  { icon: string; iconClass: string; rowClass?: string }
> = {
  collision: {
    icon: "\u26A1",
    iconClass: "bg-dash-yellow-dim text-dash-yellow",
    rowClass: "bg-dash-yellow-dim border-l-2 border-l-dash-yellow",
  },
  collision_resolved: {
    icon: "\u2713",
    iconClass: "bg-dash-green-dim text-dash-green",
    rowClass: "border-l-2 border-l-dash-green",
  },
  commit: {
    icon: "\u2192",
    iconClass: "bg-dash-green-dim text-dash-green",
  },
  error: {
    icon: "\u2716",
    iconClass: "bg-dash-yellow-dim text-dash-yellow",
    rowClass: "bg-dash-yellow-dim border-l-2 border-l-dash-yellow",
  },
  completion: {
    icon: "\u2713",
    iconClass: "bg-dash-green-dim text-dash-green",
  },
  compaction: {
    icon: "\u21BB",
    iconClass: "bg-dash-blue-dim text-dash-blue",
  },
  start: {
    icon: "\u2192",
    iconClass: "bg-dash-blue-dim text-dash-blue",
  },
  plan_started: {
    icon: "\u270E",
    iconClass: "bg-dash-purple-dim text-dash-purple",
  },
  plan_approved: {
    icon: "\u2713",
    iconClass: "bg-dash-blue-dim text-dash-blue",
  },
  task_completed: {
    icon: "\u2713",
    iconClass: "bg-dash-green-dim text-dash-green",
  },
  session_ended: {
    icon: "\u23F9",
    iconClass: "bg-dash-text-muted/10 text-dash-text-muted",
  },
  stall: {
    icon: "\u23F8",
    iconClass: "bg-dash-yellow-dim text-dash-yellow",
    rowClass: "bg-dash-yellow-dim border-l-2 border-l-dash-yellow",
  },
  idle: {
    icon: "\u2013",
    iconClass: "bg-dash-border text-dash-text-muted",
  },
  blocked: {
    icon: "\u23F8",
    iconClass: "bg-dash-blue-dim text-dash-blue",
    rowClass: "bg-dash-blue-dim border-l-2 border-l-dash-blue",
  },
};

export function FeedItem({ event, isNew, onClick, onDecide }: FeedItemProps) {
  const config = typeConfig[event.type];
  const { getOperator, isMultiOperator } = useOperators();
  const operator = isMultiOperator ? getOperator(event.operatorId) : undefined;

  const borderStyle =
    isMultiOperator && !config.rowClass && operator
      ? { borderLeftWidth: 2, borderLeftColor: operator.color }
      : undefined;

  return (
    <div
      onClick={onClick}
      style={borderStyle}
      className={`flex gap-2 px-3.5 py-2 border-b border-dash-border text-[10px] transition-colors hover:bg-dash-surface ${config.rowClass ?? ""} ${isNew ? "animate-flash-in" : ""} ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className="text-[9px] text-dash-text-muted whitespace-nowrap min-w-[40px]">
        {timeAgo(event.timestamp)}
      </div>
      <div
        className={`w-4 h-4 rounded-sm flex items-center justify-center text-[9px] shrink-0 ${config.iconClass}`}
      >
        {config.icon}
      </div>
      <div className="flex-1 leading-relaxed text-dash-text-dim">
        <span className="text-dash-text font-semibold">{event.agentLabel}</span>
        {operator && (
          <span className="text-[8px] font-mono ml-0.5" style={{ color: operator.color }}>
            [{operator.name}]
          </span>
        )}
        {" "}
        {event.message}
        {event.type === "blocked" && onDecide && (
          <span className="inline-flex items-center gap-1 ml-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); onDecide(event.sessionId, "approve"); }}
              className="text-[8px] font-semibold px-1.5 py-0.5 rounded bg-dash-green/15 text-dash-green hover:bg-dash-green/25 transition-colors"
            >
              Approve
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDecide(event.sessionId, "deny"); }}
              className="text-[8px] font-semibold px-1.5 py-0.5 rounded bg-dash-red/15 text-dash-red hover:bg-dash-red/25 transition-colors"
            >
              Deny
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

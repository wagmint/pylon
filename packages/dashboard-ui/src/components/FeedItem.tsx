"use client";

import type { FeedEvent } from "../types";
import { useOperators } from "./OperatorContext";
import { timeAgo } from "../utils";
import { DecideButtons } from "./DecideButtons";

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
  push: {
    icon: "\u21A5",
    iconClass: "bg-dash-green-dim text-dash-green",
  },
  spinning: {
    icon: "\u21BB",
    iconClass: "bg-dash-red-dim text-dash-red",
    rowClass: "bg-dash-red-dim border-l-2 border-l-dash-red",
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
      className={`flex gap-2 px-3.5 py-2 border-b border-dash-border text-xs transition-colors hover:bg-dash-surface ${config.rowClass ?? ""} ${isNew ? "animate-flash-in" : ""} ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className="text-2xs text-dash-text-muted whitespace-nowrap min-w-[40px]">
        {timeAgo(event.timestamp)}
      </div>
      <div
        className={`w-4 h-4 rounded-sm flex items-center justify-center text-2xs shrink-0 ${config.iconClass}`}
      >
        {config.icon}
      </div>
      <div className="flex-1 leading-relaxed text-dash-text-dim">
        <span className="text-dash-text font-semibold">{event.agentLabel}</span>
        {operator && (
          <span className="text-2xs font-mono ml-0.5" style={{ color: operator.color }}>
            [{operator.name}]
          </span>
        )}
        {" "}
        {event.message}
        {event.type === "blocked" && onDecide && (
          <span className="ml-1.5">
            <DecideButtons
              sessionId={event.sessionId}
              size="xs"
              onDecide={onDecide}
            />
          </span>
        )}
      </div>
    </div>
  );
}

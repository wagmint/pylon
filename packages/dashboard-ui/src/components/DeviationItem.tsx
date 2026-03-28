"use client";

import type { Collision } from "../types";
import { useOperators } from "./OperatorContext";
import { timeAgo } from "../utils";

interface DeviationItemProps {
  collision: Collision;
}

export function DeviationItem({ collision }: DeviationItemProps) {
  const fileName = collision.filePath.split("/").pop() ?? collision.filePath;
  const { getOperator, isMultiOperator } = useOperators();

  const typeConfig = collision.severity === "critical"
    ? { label: "COLLISION", className: "bg-dash-yellow-dim text-dash-yellow" }
    : { label: "OVERLAP", className: "bg-dash-yellow-dim text-dash-yellow" };

  return (
    <div className="px-3.5 py-2 border-b border-dash-border text-xs">
      <div className="flex items-center justify-between mb-0.5">
        <div className="flex items-center gap-1.5">
          <span
            className={`text-2xs font-bold tracking-widest uppercase px-1 py-px rounded ${typeConfig.className}`}
          >
            {typeConfig.label}
          </span>
          {isMultiOperator && collision.isCrossOperator && (
            <span className="text-2xs font-bold tracking-widest uppercase px-1 py-px rounded bg-dash-purple/10 text-dash-purple">
              CROSS-OP
            </span>
          )}
        </div>
        <span className="text-2xs text-dash-text-muted">
          {timeAgo(collision.detectedAt)}
        </span>
      </div>
      <div className="text-dash-text-dim leading-relaxed">
        {collision.agents.map((agent, i) => {
          const operator = isMultiOperator ? getOperator(agent.operatorId) : undefined;
          return (
            <span key={agent.sessionId}>
              {i > 0 && " & "}
              <span className="text-dash-text font-semibold">{agent.label}</span>
              {operator && (
                <span className="text-2xs font-mono ml-0.5" style={{ color: operator.color }}>
                  [{operator.name}]
                </span>
              )}
            </span>
          );
        })}
        {" "}both modifying{" "}
        <span className="text-dash-text font-semibold">{fileName}</span>
        {collision.agents[0] && (
          <span className="text-dash-text-muted">
            {" "}&mdash; {collision.agents[0].lastAction}
          </span>
        )}
      </div>
    </div>
  );
}

"use client";

import type { Collision } from "../types";
import { useOperators } from "./OperatorContext";

interface CollisionDetailProps {
  collision: Collision | null;
  onDismiss?: () => void;
}

export function CollisionDetail({ collision, onDismiss }: CollisionDetailProps) {
  const { isMultiOperator } = useOperators();

  if (!collision) {
    return (
      <div className="h-full flex items-center justify-center text-dash-text-muted text-xs">
        No collision selected
      </div>
    );
  }

  const fileName = collision.filePath.split("/").pop() ?? collision.filePath;
  const [agentA, agentB] = collision.agents;

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center justify-between px-3.5 py-2.5 bg-dash-yellow-dim border-b border-dash-yellow">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-dash-yellow text-dash-bg rounded flex items-center justify-center font-bold text-xs">
            {"\u26A1"}
          </div>
          <span className="font-display font-bold text-xs text-dash-yellow">
            Collision: {fileName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-[8px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded ${
              collision.severity === "critical"
                ? "bg-dash-yellow-dim text-dash-yellow"
                : "bg-dash-yellow-dim text-dash-yellow"
            }`}
          >
            {collision.severity}
          </span>
          {isMultiOperator && collision.isCrossOperator && (
            <span className="text-[8px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded bg-dash-purple/10 text-dash-purple">
              CROSS-OPERATOR
            </span>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="w-5 h-5 flex items-center justify-center rounded text-dash-text-muted hover:text-dash-text hover:bg-dash-surface-2 transition-colors text-xs"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_40px_1fr] gap-2.5 p-3.5">
        {agentA && (
          <CollisionSide
            label={agentA.label}
            sessionId={agentA.sessionId}
            lastAction={agentA.lastAction}
            operatorId={agentA.operatorId}
          />
        )}
        <div className="flex items-center justify-center text-dash-yellow font-bold text-sm">
          VS
        </div>
        {agentB && (
          <CollisionSide
            label={agentB.label}
            sessionId={agentB.sessionId}
            lastAction={agentB.lastAction}
            operatorId={agentB.operatorId}
          />
        )}
      </div>

      <div className="px-3.5 pb-2 text-[9px] text-dash-text-muted font-mono truncate">
        {collision.filePath}
      </div>
    </div>
  );
}

function CollisionSide({
  label,
  sessionId,
  lastAction,
  operatorId,
}: {
  label: string;
  sessionId: string;
  lastAction: string;
  operatorId: string;
}) {
  const { getOperator, isMultiOperator } = useOperators();
  const operator = isMultiOperator ? getOperator(operatorId) : undefined;

  return (
    <div
      className="bg-dash-bg rounded-md p-2.5 border border-dash-border"
      style={operator ? { borderColor: operator.color + "80" } : undefined}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="font-display font-semibold text-[11px]">{label}</span>
          {operator && (
            <span
              className="text-[8px] font-semibold px-1 py-px rounded font-mono"
              style={{ color: operator.color, backgroundColor: operator.color + "20" }}
            >
              {operator.name}
            </span>
          )}
        </div>
        <span className="text-[9px] text-dash-blue">{sessionId.slice(0, 8)}</span>
      </div>
      <div className="text-[10px] text-dash-text-dim bg-dash-surface-2 rounded p-1.5 leading-relaxed">
        {lastAction}
      </div>
    </div>
  );
}

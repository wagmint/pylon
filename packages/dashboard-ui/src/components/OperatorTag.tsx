"use client";

import { useOperators } from "./OperatorContext";

interface OperatorTagProps {
  operatorId: string;
  className?: string;
}

export function OperatorTag({ operatorId, className }: OperatorTagProps) {
  const { getOperator, isMultiOperator } = useOperators();
  if (!isMultiOperator) return null;

  const operator = getOperator(operatorId);
  if (!operator) return null;

  return (
    <span className={`inline-flex items-center gap-0.5 ${className ?? ""}`}>
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: operator.color }}
      />
      <span className="text-2xs text-dash-text-muted font-mono">
        {operator.name}
      </span>
    </span>
  );
}

"use client";

import { useState } from "react";

interface DecideButtonsProps {
  sessionId: string;
  itemCount?: number;
  showEnterHint?: boolean;
  size?: "sm" | "xs";
  onDecide?: (sessionId: string, action: "approve" | "deny") => void;
  onDecided?: (action: "approve" | "deny") => void;
}

export function DecideButtons({
  sessionId,
  itemCount,
  showEnterHint,
  size = "xs",
  onDecide,
  onDecided,
}: DecideButtonsProps) {
  const [decided, setDecided] = useState<"approve" | "deny" | null>(null);

  async function handleDecide(action: "approve" | "deny") {
    setDecided(action);
    onDecided?.(action);
    if (onDecide) {
      onDecide(sessionId, action);
    } else {
      try {
        await fetch(`http://localhost:7433/api/sessions/${sessionId}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
      } catch { /* server down — ignore */ }
    }
  }

  const textSize = size === "xs" ? "text-[8px]" : "text-[10px]";
  const px = size === "xs" ? "px-1.5" : "px-2";
  const py = "py-0.5";

  if (decided) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`inline-flex items-center justify-center w-5 h-5 rounded-full animate-decide-morph ${
            decided === "approve"
              ? "bg-dash-green/15 text-dash-green"
              : "bg-dash-red/15 text-dash-red"
          }`}
        >
          {decided === "approve" ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2,6.5 5,9.5 10,3" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="3" x2="9" y2="9" />
              <line x1="9" y1="3" x2="3" y2="9" />
            </svg>
          )}
        </span>
      </span>
    );
  }

  const approveLabel = itemCount && itemCount > 1 ? `Approve All (${itemCount})` : "Approve";

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={(e) => { e.stopPropagation(); handleDecide("approve"); }}
        className={`${textSize} font-semibold ${px} ${py} rounded bg-dash-green/15 text-dash-green hover:bg-dash-green/25 transition-colors`}
      >
        {approveLabel}
        {showEnterHint && <span className="ml-1 opacity-50">↵</span>}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); handleDecide("deny"); }}
        className={`${textSize} font-semibold ${px} ${py} rounded bg-dash-red/15 text-dash-red hover:bg-dash-red/25 transition-colors`}
      >
        Deny
      </button>
    </span>
  );
}

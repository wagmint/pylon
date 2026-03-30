"use client";

import { useState } from "react";
import type { TurnSummary } from "../types";
import { timeAgo } from "../utils";

interface TurnEntryProps {
  turn: TurnSummary;
}

const roleConfig: Record<
  TurnSummary["role"],
  { borderClass: string; timeClass: string }
> = {
  user: {
    borderClass: "border-l-2 border-l-blue-400",
    timeClass: "text-blue-400/60",
  },
  assistant: {
    borderClass: "border-l-2 border-l-dash-green",
    timeClass: "text-dash-green/60",
  },
};

function truncate(text: string, max = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "\u2026";
}

export function TurnEntry({ turn }: TurnEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const config = roleConfig[turn.role];

  const fullText =
    turn.role === "user"
      ? turn.userInstruction
      : (turn.actionSummary || turn.assistantPreview);
  const preview = truncate(fullText);

  return (
    <button
      type="button"
      onClick={() => setExpanded((e) => !e)}
      className={`w-full text-left px-2 py-1.5 ${config.borderClass} hover:bg-white/5 transition-colors rounded-r-sm`}
    >
      {/* Collapsed header — always visible */}
      <div className="flex items-center gap-2 text-2xs">
        <span className={config.timeClass}>{timeAgo(turn.timestamp)}</span>
        {turn.hasError && (
          <span className="text-dash-red" title="Error during turn">
            !
          </span>
        )}
      </div>

      <p className="text-xs text-neutral-300 mt-0.5 leading-snug">
        {expanded ? fullText : preview}
      </p>

      {/* Expanded details (assistant turns only) */}
      {expanded && turn.role === "assistant" && (
        <div className="mt-1.5 space-y-1">
          {/* Goal summary */}
          {turn.goalSummary && (
            <p className="text-2xs text-neutral-400 italic">
              {turn.goalSummary}
            </p>
          )}

          {/* File chips */}
          {turn.filesChanged.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {turn.filesChanged.map((file) => (
                <span
                  key={file}
                  className="text-2xs px-1.5 py-0.5 rounded bg-white/5 text-neutral-400 font-mono"
                >
                  {file}
                </span>
              ))}
            </div>
          )}

          {/* Commit badge */}
          {turn.hasCommit && turn.commitMessage && (
            <div className="text-2xs text-neutral-400 flex items-center gap-1">
              <span className="text-dash-green">&#x2192;</span>
              <span className="truncate">{turn.commitMessage}</span>
            </div>
          )}

          {/* Error indicator */}
          {turn.hasError && (
            <div className="text-2xs text-dash-red">
              Error occurred during this turn
            </div>
          )}
        </div>
      )}
    </button>
  );
}

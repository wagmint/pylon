"use client";

import { useRef, useEffect } from "react";
import type { Agent } from "../types";
import { AgentPip } from "./AgentPip";
import { TurnEntry } from "./TurnEntry";

interface AgentContextCardProps {
  agent: Agent;
}

export function AgentContextCard({ agent }: AgentContextCardProps) {
  const prevTurnIdsRef = useRef<Set<string> | null>(null);

  // Build set of previous turn IDs to detect new ones
  const turns = agent.recentTurns ?? [];
  const currentTurnIds = new Set(turns.map((t) => t.id));
  const newTurnIds = new Set<string>();

  if (prevTurnIdsRef.current) {
    for (const id of currentTurnIds) {
      if (!prevTurnIdsRef.current.has(id)) {
        newTurnIds.add(id);
      }
    }
  }

  useEffect(() => {
    prevTurnIdsRef.current = currentTurnIds;
  });

  const skipped = agent.skippedTurnCount ?? 0;
  // Count how many entries belong to the init turn (pinned at bottom)
  // The init turn produces 1-2 entries (user + optionally assistant)
  const lastTurnId = turns.length > 0 ? turns[turns.length - 1].id.replace(/-(?:user|assistant)$/, "") : null;
  const initPairSize = skipped > 0 && lastTurnId
    ? turns.filter((t) => t.id.startsWith(lastTurnId)).length
    : 0;

  // Derive model from most recent assistant turn
  const latestModel = turns.find(
    (t) => t.role === "assistant" && t.model,
  )?.model;

  return (
    <div className="flex flex-col">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-dash-surface-1 flex items-center gap-2 px-3 py-2 border-b border-white/5 rounded-t-md">
        <AgentPip status={agent.status} />
        <span className="text-xs font-medium text-neutral-200 truncate">
          {agent.label}
        </span>
        {latestModel && (
          <span className="text-2xs text-neutral-500 truncate">
            {latestModel}
          </span>
        )}
        <span className="ml-auto text-2xs text-neutral-500 tabular-nums">
          {turns.length} turn{turns.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Turn list — already sorted reverse-chronological from server */}
      {turns.length === 0 ? (
        <p className="px-3 py-4 text-xs text-neutral-500 italic">
          No activity yet
        </p>
      ) : (
        <div className="flex flex-col gap-px px-1 py-1">
          {turns.map((turn, i) => (
            <div key={turn.id}>
              {/* Skip indicator between recent turns and init prompt */}
              {skipped > 0 && i === turns.length - initPairSize && (
                <div className="flex items-center gap-2 px-2 py-1.5 my-0.5">
                  <div className="flex-1 border-t border-dashed border-neutral-700" />
                  <span className="text-2xs text-neutral-500 whitespace-nowrap">
                    {skipped} turn{skipped !== 1 ? "s" : ""} omitted
                  </span>
                  <div className="flex-1 border-t border-dashed border-neutral-700" />
                </div>
              )}
              <div className={newTurnIds.has(turn.id) ? "animate-flash-in" : ""}>
                <TurnEntry turn={turn} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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

  // Build set of previous turn timestamps to detect new ones
  const currentTurnIds = new Set(agent.recentTurns.map((t) => t.timestamp));
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

  // Derive model from most recent assistant turn
  const latestModel = agent.recentTurns.find(
    (t) => t.role === "assistant" && t.model,
  )?.model;

  return (
    <div className="flex flex-col">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-dash-surface-1 flex items-center gap-2 px-3 py-2 border-b border-white/5">
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
          {agent.recentTurns.length} turn{agent.recentTurns.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Turn list — already sorted reverse-chronological from server */}
      {agent.recentTurns.length === 0 ? (
        <p className="px-3 py-4 text-xs text-neutral-500 italic">
          No activity yet
        </p>
      ) : (
        <div className="flex flex-col gap-px px-1 py-1">
          {agent.recentTurns.map((turn) => (
            <div
              key={turn.timestamp}
              className={newTurnIds.has(turn.timestamp) ? "animate-flash-in" : ""}
            >
              <TurnEntry turn={turn} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

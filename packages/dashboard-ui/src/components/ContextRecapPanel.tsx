"use client";

import { useRef, useLayoutEffect, useCallback } from "react";
import type { Workstream, Agent } from "../types";
import { AgentContextCard } from "./AgentContextCard";

const STATUS_ORDER: Record<string, number> = {
  busy: 0,
  blocked: 1,
  warning: 2,
  conflict: 3,
  idle: 4,
};

function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    const statusDiff =
      (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (statusDiff !== 0) return statusDiff;

    // Within same status group, sort by most recent turn (descending)
    const aLatest = (a.recentTurns ?? [])[0]?.timestamp ?? "";
    const bLatest = (b.recentTurns ?? [])[0]?.timestamp ?? "";
    return bLatest.localeCompare(aLatest);
  });
}

interface ContextRecapPanelProps {
  workstream: Workstream;
}

export function ContextRecapPanel({ workstream }: ContextRecapPanelProps) {
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevRects = useRef<Map<string, DOMRect>>(new Map());

  const sorted = sortAgents(workstream.agents);

  // Capture rects before React commits the new order
  const captureRects = useCallback(() => {
    const rects = new Map<string, DOMRect>();
    for (const [id, el] of cardRefs.current) {
      rects.set(id, el.getBoundingClientRect());
    }
    prevRects.current = rects;
  }, []);

  // FLIP animation: after DOM updates, animate from old positions
  useLayoutEffect(() => {
    for (const agent of sorted) {
      const el = cardRefs.current.get(agent.sessionId);
      if (!el) continue;

      const next = el.getBoundingClientRect();
      const prev = prevRects.current.get(agent.sessionId);

      if (prev) {
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;

        if (dx !== 0 || dy !== 0) {
          el.style.transition = "none";
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          void el.offsetWidth;
          el.style.transition =
            "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
          el.style.transform = "";
        }
      }
    }
  });

  // Capture rects before each render for the next FLIP cycle
  // Using a ref callback pattern: capture on every re-render
  useLayoutEffect(() => {
    return () => {
      captureRects();
    };
  });

  const setCardRef = useCallback(
    (sessionId: string) => (el: HTMLDivElement | null) => {
      if (el) {
        cardRefs.current.set(sessionId, el);
      } else {
        cardRefs.current.delete(sessionId);
      }
    },
    [],
  );

  if (workstream.agents.length === 0) {
    return (
      <div className="px-3.5 py-8 text-center text-dash-text-muted text-xs">
        No agents in this workstream
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full">
      {sorted.map((agent, i) => (
        <div key={agent.sessionId} ref={setCardRef(agent.sessionId)}>
          {i > 0 && <div className="border-t border-dash-border" />}
          <AgentContextCard agent={agent} />
        </div>
      ))}
    </div>
  );
}

/** Skeleton placeholder while SSE data loads */
export function ContextRecapPanelSkeleton() {
  return (
    <div className="flex flex-col gap-px p-2 animate-pulse">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-neutral-700" />
            <div className="h-3 w-24 bg-neutral-700 rounded" />
            <div className="ml-auto h-3 w-12 bg-neutral-700 rounded" />
          </div>
          <div className="h-3 w-full bg-neutral-800 rounded" />
          <div className="h-3 w-3/4 bg-neutral-800 rounded" />
        </div>
      ))}
    </div>
  );
}

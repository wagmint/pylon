"use client";

import { useState, useCallback } from "react";
import type { ContextMap } from "../context-map/types";
import { ContextMapGraph } from "./ContextMapGraph";
import { TaskHandoffDrawer } from "./TaskHandoffDrawer";

interface ContextMapSectionProps {
  contextMap: ContextMap;
}

export function ContextMapSection({ contextMap }: ContextMapSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const handoff = selectedTaskId
    ? contextMap.handoffs.find((h) => h.taskId === selectedTaskId) ?? null
    : null;

  const handleClose = useCallback(() => setSelectedTaskId(null), []);

  const isEmpty =
    contextMap.summary.goals === 0 && contextMap.summary.tasks === 0;

  if (isEmpty) {
    return (
      <div className="mt-6">
        <div className="flex items-center gap-3 px-4 py-2.5 bg-dash-surface border border-dash-border rounded-md">
          <span className="text-dash-text-muted text-2xs">▶</span>
          <span className="text-xs font-semibold text-dash-text uppercase tracking-wider">
            Context Map
          </span>
          <span className="text-[10px] text-dash-text-muted">
            No context map data yet
          </span>
        </div>
      </div>
    );
  }

  const { summary } = contextMap;

  return (
    <div className="mt-6">
      {/* Collapsed / header bar */}
      <div
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between px-4 py-2.5 bg-dash-surface border border-dash-border rounded-md cursor-pointer hover:bg-dash-surface-2 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-dash-text-muted text-2xs">
            {expanded ? "▼" : "▶"}
          </span>
          <span className="text-xs font-semibold text-dash-text uppercase tracking-wider">
            Context Map
          </span>
          <span className="text-[10px] text-dash-text-muted">
            {summary.goals} goal{summary.goals !== 1 ? "s" : ""} ·{" "}
            {summary.tasks} task{summary.tasks !== 1 ? "s" : ""} ·{" "}
            {summary.blockedTasks > 0 && `${summary.blockedTasks} blocked · `}
            {summary.activeTasks} active
          </span>
        </div>
        <div className="flex gap-1.5">
          {summary.completedTasks > 0 && (
            <span className="text-[9px] bg-[#1a2a1a] text-dash-green px-1.5 py-0.5 rounded">
              {summary.completedTasks} completed
            </span>
          )}
          {summary.blockedTasks > 0 && (
            <span className="text-[9px] bg-[#2a1a1a] text-dash-red px-1.5 py-0.5 rounded">
              {summary.blockedTasks} blocked
            </span>
          )}
        </div>
      </div>

      {/* Expanded graph + drawer */}
      {expanded && (
        <div className="flex border border-t-0 border-dash-border rounded-b-md overflow-hidden h-[400px]">
          <div className="flex-1 min-w-0">
            <ContextMapGraph
              contextMap={contextMap}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          </div>
          {handoff && (
            <TaskHandoffDrawer handoff={handoff} onClose={handleClose} />
          )}
        </div>
      )}
    </div>
  );
}

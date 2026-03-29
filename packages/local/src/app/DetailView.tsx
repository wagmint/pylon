"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  Workstream,
  FeedEvent,
  PlanWindow,
} from "@hexdeck/dashboard-ui";
import {
  WorkstreamNode,
  FeedItem,
  PlanDetail,
  ContextRecapPanel,
  ContextRecapPanelSkeleton,
} from "@hexdeck/dashboard-ui";

type Tab = "context-recap" | "live-feed" | "plans";

const TABS: { key: Tab; label: string }[] = [
  { key: "context-recap", label: "Context Recap" },
  { key: "live-feed", label: "Live Feed" },
  { key: "plans", label: "Plans" },
];

interface DetailViewProps {
  workstream: Workstream;
  feed: FeedEvent[];
  planWindow?: PlanWindow;
  onPlanWindowChange?: (w: PlanWindow) => void;
  onDecide?: (sessionId: string, action: "approve" | "deny") => void;
}

export function DetailView({
  workstream,
  feed,
  planWindow = "24h",
  onPlanWindowChange,
  onDecide,
}: DetailViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("context-recap");

  // Reset tab to Context Recap when workstream changes
  useEffect(() => {
    setActiveTab("context-recap");
  }, [workstream.projectId]);

  const filteredFeed = feed.filter(
    (e) => e.projectPath === workstream.projectPath
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div className="flex border-b border-dash-border shrink-0">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-xs font-semibold tracking-wide transition-colors ${
                isActive
                  ? "text-dash-text border-b-2 border-dash-green"
                  : "text-dash-text-muted hover:text-dash-text-dim"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {activeTab === "context-recap" && (
          <ContextRecapPanel workstream={workstream} />
        )}

        {activeTab === "live-feed" && (
          <div>
            {filteredFeed.length === 0 ? (
              <div className="px-3.5 py-8 text-center text-dash-text-muted text-xs">
                No events for this workstream
              </div>
            ) : (
              filteredFeed.map((event) => (
                <FeedItem
                  key={event.id}
                  event={event}
                  onDecide={onDecide}
                />
              ))
            )}
          </div>
        )}

        {activeTab === "plans" && (
          <PlanDetail
            workstreams={[workstream]}
            localPlanCollisions={[]}
            planWindow={planWindow}
            onPlanWindowChange={onPlanWindowChange}
          />
        )}
      </div>
    </div>
  );
}

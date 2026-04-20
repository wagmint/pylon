"use client";

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { useDashboard } from "@/hooks/useDashboard";
import { useRelay } from "@/hooks/useRelay";
import { decideSession } from "@/lib/dashboard-api";
import type { DashboardState, RelayStatus, PlanWindow } from "@hexdeck/dashboard-ui";
import {
  OperatorProvider,
  TopBar,
  PanelHeader,
  AgentCard,
  RiskPanel,
  RelayPanel,
} from "@hexdeck/dashboard-ui";
import { GuidedTour } from "@/components/GuidedTour";
import { MeSpendView } from "./MeSpendView";
import { DetailView } from "./DetailView";

export default function DashboardPage() {
  const { state, loading, error, connected } = useDashboard();
  const [relayOpen, setRelayOpen] = useState(false);
  const relay = useRelay(relayOpen);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  const [planWindow, setPlanWindow] = useState<PlanWindow>("24h");
  const workstreamItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const previousWorkstreamRects = useRef<Map<string, DOMRect>>(new Map());
  const workstreamsForAnimation = state?.workstreams ?? [];

  // Approve/deny a blocked agent from the UI
  const handleDecide = useCallback(async (sessionId: string, action: "approve" | "deny") => {
    try {
      await decideSession(sessionId, action);
    } catch { /* server down — ignore */ }
  }, []);

  // Workstream selection
  const selectWorkstream = useCallback((projectPath: string) => {
    setSelectedProjectPath(prev => prev === projectPath ? null : projectPath);
  }, []);

  // Escape key clears selection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedProjectPath(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Clear selection if selected workstream disappears from state
  useEffect(() => {
    if (!state || selectedProjectPath === null) return;
    const exists = state.workstreams.some(ws => ws.projectPath === selectedProjectPath);
    if (!exists) setSelectedProjectPath(null);
  }, [state, selectedProjectPath]);

  const setWorkstreamItemRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) {
        workstreamItemRefs.current.set(id, el);
      } else {
        workstreamItemRefs.current.delete(id);
      }
    },
    []
  );

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();

    for (const ws of workstreamsForAnimation) {
      const el = workstreamItemRefs.current.get(ws.projectId);
      if (!el) continue;

      const next = el.getBoundingClientRect();
      const prev = previousWorkstreamRects.current.get(ws.projectId);

      if (prev) {
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;

        if (dx !== 0 || dy !== 0) {
          el.style.transition = "none";
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          void el.offsetWidth;
          el.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
          el.style.transform = "";
        }
      }

      nextRects.set(ws.projectId, next);
    }

    previousWorkstreamRects.current = nextRects;
  }, [workstreamsForAnimation]);

  if (loading && !state) {
    return (
      <div className="h-screen bg-dash-bg flex items-center justify-center text-dash-text-muted text-sm font-mono">
        Scanning sessions...
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="h-screen bg-dash-bg flex items-center justify-center text-dash-red text-sm font-mono">
        {error}
      </div>
    );
  }

  if (!state) return null;

  const { operators, workstreams, agents, feed, summary } = state;

  // Empty state: Hexdeck is running but no sessions found
  const isEmpty = workstreams.length === 0 && agents.length === 0 && feed.length === 0;

  if (isEmpty) {
    return (
      <div className="h-screen flex flex-col bg-dash-bg text-dash-text font-mono">
        <TopBar
          summary={summary}
          operators={operators}
          relayStatus={null}
          onRelayClick={() => {}}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <div className="text-dash-text-muted text-4xl mb-6">&#9678;</div>
            <h2 className="text-lg font-medium text-dash-text mb-3">Hexdeck is running</h2>
            <p className="text-sm text-dash-text-muted leading-relaxed mb-6">
              No sessions detected yet. Start a Claude Code or Codex session in any project
              and it will appear here automatically.
            </p>
            <div className="text-xs text-dash-text-dim space-y-2">
              <p>Sessions are read from <code className="bg-dash-surface-2 px-1.5 py-0.5 rounded">~/.claude/projects/</code></p>
              <p>Dashboard updates every second via SSE</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const relayStatus: RelayStatus | null =
    relay.targets.length > 0
      ? {
          targetCount: relay.targets.length,
          connectedCount: relay.targets.filter((t) => t.status === "connected").length,
        }
      : null;

  const selectedWorkstream = selectedProjectPath !== null
    ? workstreams.find(ws => ws.projectPath === selectedProjectPath) ?? null
    : null;

  const selectedFeed = selectedWorkstream
    ? feed.filter(e => e.projectPath === selectedProjectPath)
    : [];

  return (
    <OperatorProvider operators={operators}>
    <div className="h-screen flex flex-col bg-dash-bg text-dash-text font-mono text-[11px] leading-relaxed overflow-hidden">
      <div data-tour="topbar">
        <TopBar
          summary={summary}
          operators={operators}
          relayStatus={relayStatus}
          onRelayClick={() => setRelayOpen((prev) => !prev)}
        />
      </div>

      <div
        className="flex-1 grid gap-px bg-dash-border min-h-0"
        style={{ gridTemplateColumns: "minmax(200px, 240px) 1fr minmax(260px, 320px)", gridTemplateRows: "1fr" }}
      >
        {/* LEFT PANEL: Workstream cards */}
        <div data-tour="agents" className="relative z-20 bg-dash-bg overflow-y-auto scrollbar-thin">
          <PanelHeader
            title="Workstreams"
            count={`${workstreams.length} project${workstreams.length !== 1 ? "s" : ""}`}
          />
          {workstreams.length === 0 ? (
            <div className="px-3.5 py-8 text-center text-dash-text-muted text-xs">
              No active projects
            </div>
          ) : (
            workstreams.map((ws) => (
              <div key={ws.projectId} ref={setWorkstreamItemRef(ws.projectId)} className="will-change-transform">
                <AgentCard
                  workstream={ws}
                  isSelected={selectedProjectPath === ws.projectPath}
                  onSelect={selectWorkstream}
                  onDecide={handleDecide}
                />
              </div>
            ))
          )}
        </div>

        {/* CENTER PANEL: Detail or Home */}
        <div className="bg-dash-bg min-h-0 overflow-y-auto scrollbar-thin">
          {selectedWorkstream ? (
            <DetailView
              workstream={selectedWorkstream}
              feed={selectedFeed}
              planWindow={planWindow}
              onPlanWindowChange={setPlanWindow}
              onDecide={handleDecide}
            />
          ) : (
            <MeSpendView state={state} />
          )}
        </div>

        {/* RIGHT PANEL: Risk */}
        <div className="bg-dash-bg min-h-0 overflow-y-auto scrollbar-thin">
          <PanelHeader
            title="Risk"
            count={`${agents.filter(a => a.risk.overallRisk !== "nominal").length} at risk`}
          />
          <RiskPanel agents={agents} />
        </div>
      </div>

      <GuidedTour />

      {/* Relay Panel overlay */}
      {relayOpen && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setRelayOpen(false)}
          />
          <div className="fixed top-0 right-0 z-30 h-full w-[480px] shadow-lg">
            <RelayPanel
              targets={relay.targets}
              activeProjects={relay.activeProjects}
              pendingOnboarding={relay.pendingOnboarding}
              onRemove={relay.remove}
              onToggleProject={relay.toggleProject}
              onOpenJoinUrl={relay.openJoinUrl}
              onCancelOnboarding={relay.cancelOnboarding}
              onClose={() => setRelayOpen(false)}
            />
          </div>
        </>
      )}
    </div>
    </OperatorProvider>
  );
}

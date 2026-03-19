"use client";

import { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from "react";
import { useDashboard } from "@/hooks/useDashboard";
import { useRelay } from "@/hooks/useRelay";
import { decideSession } from "@/lib/dashboard-api";
import type { DashboardState, RelayStatus, PlanWindow } from "@hexdeck/dashboard-ui";
import {
  OperatorProvider,
  TopBar,
  PanelHeader,
  AgentCard,
  WorkstreamNode,
  FeedItem,
  PlanDetail,
  RiskPanel,
  RelayPanel,
} from "@hexdeck/dashboard-ui";
import { GuidedTour } from "@/components/GuidedTour";

export default function DashboardPage() {
  type DashboardAgent = DashboardState["agents"][number];
  const RISK_INACTIVE_HOLD_MS = 30_000;
  const { state, loading, error, connected } = useDashboard();
  const [relayOpen, setRelayOpen] = useState(false);
  const relay = useRelay(relayOpen);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  const [seenEventIds, setSeenEventIds] = useState<Set<string>>(new Set());
  const isFirstRender = useRef(true);
  const [planWindow, setPlanWindow] = useState<PlanWindow>("24h");
  const [bottomPanelHeight, setBottomPanelHeight] = useState(400);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const workstreamItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const previousWorkstreamRects = useRef<Map<string, DOMRect>>(new Map());
  const workstreamsForAnimation = state?.workstreams ?? [];
  const liveAgentsForRisk = state?.agents ?? [];
  const riskAgentHold = useRef<Map<string, { agent: DashboardAgent; lastSeenAt: number }>>(new Map());
  const [riskHoldClock, setRiskHoldClock] = useState(0);

  const makeResizeHandler = useCallback(
    (setter: (h: number) => void, currentHeight: number, min = 80) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        isDragging.current = true;
        dragStartY.current = e.clientY;
        dragStartHeight.current = currentHeight;
        const maxH = Math.floor(window.innerHeight * 0.9);

        const onMouseMove = (ev: MouseEvent) => {
          if (!isDragging.current) return;
          const delta = dragStartY.current - ev.clientY;
          setter(Math.min(Math.max(dragStartHeight.current + delta, min), maxH));
        };

        const onMouseUp = () => {
          isDragging.current = false;
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      },
    []
  );

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => makeResizeHandler(setBottomPanelHeight, bottomPanelHeight)(e),
    [bottomPanelHeight, makeResizeHandler]
  );


  // Approve/deny a blocked agent from the UI
  const handleDecide = useCallback(async (sessionId: string, action: "approve" | "deny") => {
    try {
      await decideSession(sessionId, action);
    } catch { /* server down — ignore */ }
  }, []);

  // Workstream focus filter
  const toggleWorkstream = useCallback((projectPath: string) => {
    setSelectedProjectPath(prev => prev === projectPath ? null : projectPath);
  }, []);

  // Escape key clears workstream filter
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedProjectPath(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Track seen event IDs for flash-in animation
  useEffect(() => {
    if (!state) return;
    if (isFirstRender.current) {
      // On first render, mark all events as seen (no flash)
      setSeenEventIds(new Set(state.feed.map((e) => e.id)));
      isFirstRender.current = false;
      return;
    }
    // After first render, only newly arrived events get flash
    setSeenEventIds((prev) => {
      const next = new Set(prev);
      for (const e of state.feed) next.add(e.id);
      return next;
    });
  }, [state]);

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

  useEffect(() => {
    const now = Date.now();
    const next = new Map(riskAgentHold.current);

    for (const agent of liveAgentsForRisk) {
      next.set(agent.sessionId, { agent, lastSeenAt: now });
    }
    for (const [sessionId, entry] of next) {
      if (now - entry.lastSeenAt > RISK_INACTIVE_HOLD_MS) {
        next.delete(sessionId);
      }
    }

    riskAgentHold.current = next;
    setRiskHoldClock(now);
  }, [liveAgentsForRisk, RISK_INACTIVE_HOLD_MS]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const next = new Map(riskAgentHold.current);
      let changed = false;

      for (const [sessionId, entry] of next) {
        if (now - entry.lastSeenAt > RISK_INACTIVE_HOLD_MS) {
          next.delete(sessionId);
          changed = true;
        }
      }

      if (changed) {
        riskAgentHold.current = next;
      }
      setRiskHoldClock(now);
    }, 2_000);

    return () => clearInterval(timer);
  }, [RISK_INACTIVE_HOLD_MS]);

  const heldRiskAgents = useMemo(() => {
    const now = riskHoldClock || Date.now();
    const bySessionId = new Map<string, DashboardAgent>();

    // Always include currently-live agents from state.
    for (const agent of liveAgentsForRisk) {
      bySessionId.set(agent.sessionId, agent);
    }

    for (const { agent, lastSeenAt } of riskAgentHold.current.values()) {
      if (now - lastSeenAt <= RISK_INACTIVE_HOLD_MS) {
        if (!bySessionId.has(agent.sessionId)) {
          bySessionId.set(agent.sessionId, agent);
        }
      }
    }

    return [...bySessionId.values()];
  }, [liveAgentsForRisk, riskHoldClock, RISK_INACTIVE_HOLD_MS]);

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

  const { operators, agents, workstreams, feed, summary } = state;

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

  const isFiltered = selectedProjectPath !== null;
  const filteredWorkstreams = isFiltered
    ? workstreams.filter(ws => ws.projectPath === selectedProjectPath)
    : workstreams;
  const filteredFeed = isFiltered
    ? feed.filter(e => e.projectPath === selectedProjectPath)
    : feed;
  const filteredAgents = isFiltered
    ? heldRiskAgents.filter(a => a.projectPath === selectedProjectPath)
    : heldRiskAgents;
  const selectedName = isFiltered
    ? workstreams.find(ws => ws.projectPath === selectedProjectPath)?.name
    : null;

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
        style={{ gridTemplateColumns: "260px 1fr 320px", gridTemplateRows: "1fr" }}
      >
        {/* LEFT PANEL: Workstream / Agent cards */}
        <div data-tour="agents" className="relative z-20 bg-dash-bg overflow-y-auto scrollbar-thin">
          <PanelHeader
            title={isFiltered && selectedName ? `Filtered: ${selectedName}` : "Workstreams"}
            count={isFiltered ? undefined : `${workstreams.length} project${workstreams.length !== 1 ? "s" : ""}`}
          >
            {isFiltered && (
              <button
                onClick={() => setSelectedProjectPath(null)}
                className="bg-dash-surface-3 px-1.5 py-0.5 rounded text-dash-text-dim font-normal tracking-normal normal-case hover:text-dash-text transition-colors"
              >
                ✕ clear
              </button>
            )}
          </PanelHeader>
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
                  onSelect={toggleWorkstream}
                  onDecide={handleDecide}
                />
              </div>
            ))
          )}
        </div>

        {/* CENTER PANEL */}
        <div className="flex flex-col bg-dash-bg min-h-0">
          {/* Top: Intent Map + Live Feed */}
          <div className="flex-1 min-h-0 grid gap-px bg-dash-border" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div data-tour="intent-map" className="bg-dash-bg overflow-y-auto scrollbar-thin">
              <PanelHeader
                title="Intent Map"
                count={`${filteredWorkstreams.length} project${filteredWorkstreams.length !== 1 ? "s" : ""}`}
              />
              {filteredWorkstreams.length === 0 ? (
                <div className="px-3.5 py-8 text-center text-dash-text-muted text-xs">
                  No workstreams to map
                </div>
              ) : (
                filteredWorkstreams.map((workstream) => (
                  <WorkstreamNode key={workstream.projectId} workstream={workstream} />
                ))
              )}
            </div>

            <div data-tour="live-feed" className="bg-dash-bg overflow-y-auto scrollbar-thin">
              <PanelHeader title="Live Feed">
                <span className="inline-flex items-center gap-1 bg-dash-green-dim text-dash-green text-[8px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase">
                  <span className="w-1 h-1 rounded-full bg-dash-green animate-dash-pulse" />
                  streaming
                </span>
              </PanelHeader>
              {filteredFeed.length === 0 ? (
                <div className="px-3.5 py-8 text-center text-dash-text-muted text-xs">
                  No events yet
                </div>
              ) : (
                filteredFeed.map((event) => (
                  <FeedItem
                    key={event.id}
                    event={event}
                    isNew={!isFirstRender.current && !seenEventIds.has(event.id)}
                    onDecide={handleDecide}
                  />
                ))
              )}
            </div>
          </div>

          {/* Bottom: Plan / Collision Detail (resizable) */}
          <div data-tour="plans" className="shrink-0 bg-dash-surface overflow-hidden" style={{ height: bottomPanelHeight }}>
            {/* Drag handle */}
            <div
              onMouseDown={onResizeStart}
              className="h-5 cursor-row-resize border-t border-dash-border hover:bg-dash-surface-2 active:bg-dash-blue/20 transition-colors flex flex-col items-center justify-center gap-[3px]"
            >
              <span className="block w-8 border-t border-dash-text-muted/40" />
              <span className="block w-8 border-t border-dash-text-muted/40" />
              <span className="block w-8 border-t border-dash-text-muted/40" />
            </div>
            <PlanDetail
              workstreams={filteredWorkstreams}
              localPlanCollisions={[]}
              planWindow={planWindow}
              onPlanWindowChange={setPlanWindow}
            />
          </div>
        </div>

        {/* RIGHT PANEL: Risk Analytics */}
        <div data-tour="risk" className="bg-dash-bg overflow-y-auto scrollbar-thin">
          <PanelHeader
            title="Risk"
            count={`${summary.agentsAtRisk} at risk`}
          />
          {filteredAgents.length === 0 ? (
            <div className="px-3.5 py-8 text-center text-dash-text-muted text-xs">
              No agents to analyze
            </div>
          ) : (
            <RiskPanel agents={filteredAgents} />
          )}
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
              onConnect={relay.connect}
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

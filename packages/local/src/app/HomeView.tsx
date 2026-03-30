"use client";

import { useState, useCallback } from "react";
import type { DashboardState, Agent } from "@hexdeck/dashboard-ui";
import { DecideButtons } from "@hexdeck/dashboard-ui";
import { decideSession } from "@/lib/dashboard-api";

interface HomeViewProps {
  state: DashboardState;
}

export function HomeView({ state }: HomeViewProps) {
  const { summary, agents, workstreams } = state;
  const [decideErrors, setDecideErrors] = useState<Map<string, string>>(new Map());

  const blockedAgents = agents.filter(
    (a): a is Agent & { blockedOn: NonNullable<Agent["blockedOn"]> } =>
      a.status === "blocked" && !!a.blockedOn && a.blockedOn.length > 0
  );

  const handleDecide = useCallback(
    async (sessionId: string, action: "approve" | "deny") => {
      // Clear any previous error for this session
      setDecideErrors((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      try {
        await decideSession(sessionId, action);
      } catch {
        setDecideErrors((prev) => {
          const next = new Map(prev);
          next.set(sessionId, `Failed to ${action} — server may be unavailable`);
          return next;
        });
      }
    },
    []
  );

  // Fall through to existing empty state when no workstreams exist
  if (workstreams.length === 0 && agents.length === 0) {
    return null;
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      {/* Summary stats */}
      <div className="flex items-center gap-6 text-xs text-dash-text-muted mb-8">
        <Stat label="Active Agents" value={summary.activeAgents} />
        <Stat label="Blocked" value={summary.blockedAgents} highlight={summary.blockedAgents > 0} />
        <Stat label="Commits" value={summary.totalCommits} />
        <Stat label="Tokens" value={formatNumber(summary.totalTokens)} />
      </div>

      {/* Blocked agents panel */}
      <div>
        <h3 className="text-xs font-semibold text-dash-text uppercase tracking-wider mb-3">
          Awaiting Approval
        </h3>

        {blockedAgents.length === 0 ? (
          <div className="text-xs text-dash-text-muted py-4">
            No agents waiting for approval
          </div>
        ) : (
          <div className="space-y-2">
            {blockedAgents.map((agent) => (
              <div key={agent.sessionId}>
                {agent.blockedOn.map((item, i) => (
                  <div
                    key={item.requestId ?? i}
                    className="flex items-start justify-between gap-3 bg-dash-surface rounded px-3 py-2 border-l-2 border-dash-blue"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-dash-text truncate">
                        <span className="text-dash-text-muted">{agent.label}</span>
                        {" · "}
                        <span className="font-mono text-dash-blue">{item.toolName}</span>
                      </div>
                      <div className="text-2xs text-dash-text-muted truncate mt-0.5">
                        {item.description}
                      </div>
                      {item.detail && (
                        <div
                          className="text-2xs text-dash-text-dim font-mono truncate mt-0.5"
                          title={item.detail}
                        >
                          {item.detail}
                        </div>
                      )}
                      {decideErrors.has(agent.sessionId) && (
                        <div className="text-2xs text-dash-red mt-1">
                          {decideErrors.get(agent.sessionId)}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 pt-0.5">
                      <DecideButtons
                        sessionId={agent.sessionId}
                        onDecide={handleDecide}
                        size="xs"
                      />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-2xs text-dash-text-muted mt-8 text-center">
        Select a workstream to view context recap, live feed, and plans
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span
        className={`text-sm font-semibold tabular-nums ${
          highlight ? "text-dash-blue" : "text-dash-text"
        }`}
      >
        {value}
      </span>
      <span className="text-2xs">{label}</span>
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

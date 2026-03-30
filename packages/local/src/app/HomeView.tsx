"use client";

import { useState, useCallback, useMemo } from "react";
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

  // Aggregate model usage across all agents
  const modelBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const agent of agents) {
      for (const m of agent.risk.modelBreakdown) {
        map.set(m.model, (map.get(m.model) ?? 0) + m.tokenCount);
      }
    }
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, tokens]) => sum + tokens, 0);
    return entries.map(([model, tokens]) => ({
      model: shortModelName(model),
      tokens,
      pct: total > 0 ? tokens / total : 0,
    }));
  }, [agents]);

  // Fall through to existing empty state when no workstreams exist
  if (workstreams.length === 0 && agents.length === 0) {
    return null;
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      {/* Summary stats + model breakdown */}
      <div className="inline-block mb-8">
        <div className="flex items-center gap-6 text-xs text-dash-text-muted">
          <Stat label="Active Agents" value={summary.activeAgents} />
          <Stat label="Blocked" value={summary.blockedAgents} highlight={summary.blockedAgents > 0} />
          <Stat label="Commits" value={summary.totalCommits} />
          <Stat label="Tokens" value={formatNumber(summary.totalTokens)} />
          <Stat label="Spend" value={formatCost(summary.totalCost)} />
        </div>

        {/* Model breakdown — bars constrained to stats row width */}
        {modelBreakdown.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {modelBreakdown.map(({ model, pct }) => (
              <div key={model} className="flex items-center gap-2">
                <span className="text-2xs text-dash-text-muted w-20 shrink-0 truncate" title={model}>
                  {model}
                </span>
                <div className="flex-1 h-1.5 bg-dash-surface-3 rounded-sm overflow-hidden">
                  <div
                    className="h-full rounded-sm bg-dash-blue"
                    style={{ width: `${Math.round(pct * 100)}%` }}
                  />
                </div>
                <span className="text-2xs text-dash-text-dim w-8 text-right tabular-nums">
                  {Math.round(pct * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}
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

function formatCost(n: number): string {
  if (!n || isNaN(n)) return "$0";
  if (n < 0.01) return "$0";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

function shortModelName(model: string): string {
  const l = model.toLowerCase();
  if (l.startsWith("claude-opus-4-6")) return "Opus 4.6";
  if (l.startsWith("claude-opus-4-5")) return "Opus 4.5";
  if (l.startsWith("claude-opus-4-1")) return "Opus 4.1";
  if (l.startsWith("claude-opus-4")) return "Opus 4";
  if (l.startsWith("claude-sonnet-4-5")) return "Sonnet 4.5";
  if (l.startsWith("claude-sonnet-4")) return "Sonnet 4";
  if (l.startsWith("claude-sonnet-3")) return "Sonnet 3.5";
  if (l.startsWith("claude-haiku-4-5")) return "Haiku 4.5";
  if (l.startsWith("claude-haiku-3")) return "Haiku 3.5";
  if (l.startsWith("gpt-5.3-codex")) return "GPT-5.3 Codex";
  if (l.startsWith("gpt-5.2-codex")) return "GPT-5.2 Codex";
  if (l.startsWith("gpt-5.1-codex-mini")) return "Codex Mini 5.1";
  if (l.startsWith("gpt-5.1-codex")) return "Codex 5.1";
  if (l.startsWith("gpt-5-codex")) return "Codex 5";
  if (l.startsWith("codex-mini")) return "Codex Mini";
  if (l.startsWith("o4-mini")) return "o4-mini";
  if (l.startsWith("o3-mini")) return "o3-mini";
  return model;
}

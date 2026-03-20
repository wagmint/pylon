"use client";

import type { DashboardSummary, Operator } from "../types";

export interface RelayStatus {
  targetCount: number;
  connectedCount: number;
}

interface TopBarProps {
  summary: DashboardSummary;
  operators: Operator[];
  relayStatus?: RelayStatus | null;
  onRelayClick?: () => void;
}

export function TopBar({ summary, operators, relayStatus, onRelayClick }: TopBarProps) {
  return (
    <div className="flex items-center justify-between px-4 h-10 bg-dash-surface border-b border-dash-border">
      <div className="inline-flex items-center gap-2 font-display font-bold text-sm tracking-tight text-dash-green">
        <svg viewBox="0 0 64 64" aria-hidden="true" className="w-4 h-4 shrink-0">
          <defs>
            <radialGradient id="hexdeckTopbarCore" cx="50%" cy="45%" r="60%">
              <stop offset="0%" stopColor="#DDFFE9" />
              <stop offset="45%" stopColor="#51F2A1" />
              <stop offset="100%" stopColor="#00E87B" />
            </radialGradient>
          </defs>
          <polygon
            points="32,6 54,19 54,45 32,58 10,45 10,19"
            fill="none"
            stroke="#00E87B"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <polygon
            points="32,21 41,26 41,38 32,43 23,38 23,26"
            fill="url(#hexdeckTopbarCore)"
          />
        </svg>
        HEXDECK{" "}
        <span className="font-normal text-dash-text-dim">control surface</span>
      </div>
      <div className="flex items-center gap-6">
        <div className="inline-flex items-center gap-1 bg-dash-green-dim text-dash-green text-[8px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase">
          <span className="w-1 h-1 rounded-full bg-dash-green animate-dash-pulse" />
          LIVE
        </div>
        <RelayIndicator relayStatus={relayStatus} onRelayClick={onRelayClick} />
        {operators.length > 1 && (
          <div className="flex items-center gap-2 px-2 border-l border-r border-dash-border">
            {operators.map((op) => (
              <div key={op.id} className="flex items-center gap-1">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${op.status === "online" ? "animate-dash-pulse" : "opacity-40"}`}
                  style={{ backgroundColor: op.color }}
                />
                <span className="text-[9px] text-dash-text-dim font-mono">{op.name}</span>
              </div>
            ))}
          </div>
        )}
        <StatusItem
          color="green"
          text={`${summary.activeAgents} agent${summary.activeAgents !== 1 ? "s" : ""} active`}
        />
        {summary.totalCollisions > 0 && (
          <StatusItem
            color="yellow"
            text={`${summary.totalCollisions} collision${summary.totalCollisions !== 1 ? "s" : ""}`}
          />
        )}
        {summary.criticalCollisions > 0 && (
          <StatusItem
            color="yellow"
            text={`${summary.criticalCollisions} critical`}
          />
        )}
        {summary.blockedAgents > 0 && (
          <StatusItem
            color="blue"
            text={`${summary.blockedAgents} waiting`}
          />
        )}
        {summary.agentsAtRisk > 0 && (
          <StatusItem
            color="yellow"
            text={`${summary.agentsAtRisk} agent${summary.agentsAtRisk !== 1 ? "s" : ""} at risk`}
          />
        )}
        <span className="text-dash-text-muted text-[11px] font-mono">
          {summary.totalWorkstreams} project{summary.totalWorkstreams !== 1 ? "s" : ""}
          {" / "}
          {summary.totalCommits} commit{summary.totalCommits !== 1 ? "s" : ""}
        </span>
        {summary.totalTokens > 0 && (
          <span className="text-dash-text-muted text-[11px] font-mono" title="Recorded tokens from active sessions">
            {formatTokens(summary.totalTokens)} tokens
          </span>
        )}
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function RelayIndicator({
  relayStatus,
  onRelayClick,
}: {
  relayStatus?: RelayStatus | null;
  onRelayClick?: () => void;
}) {
  if (!relayStatus || relayStatus.targetCount === 0) {
    return (
      <button
        onClick={onRelayClick}
        className="text-[8px] font-bold tracking-widest uppercase text-dash-text-muted/40 hover:text-dash-text-muted transition-colors cursor-pointer"
      >
        RELAY
      </button>
    );
  }

  const { targetCount, connectedCount } = relayStatus;
  let dotClass: string;
  if (connectedCount === targetCount) {
    dotClass = "bg-dash-green animate-dash-pulse";
  } else if (connectedCount > 0) {
    dotClass = "bg-dash-blue animate-dash-breathe";
  } else {
    dotClass = "bg-dash-text-muted";
  }

  return (
    <button
      onClick={onRelayClick}
      className="inline-flex items-center gap-1 text-[11px] font-mono text-dash-text-dim hover:text-dash-text transition-colors cursor-pointer"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      {targetCount} relay
    </button>
  );
}

function StatusItem({ color, text }: { color: "green" | "yellow" | "red" | "blue"; text: string }) {
  const dotColor = {
    green: "bg-dash-green",
    yellow: "bg-dash-yellow",
    red: "bg-dash-red",
    blue: "bg-dash-blue",
  }[color];

  const pulseClass = color === "red"
    ? "animate-conflict-flash"
    : color === "blue"
      ? "animate-dash-breathe"
      : "animate-dash-pulse";

  return (
    <div className="flex items-center gap-1.5 text-dash-text-dim text-[11px] font-mono">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor} ${pulseClass}`} />
      {text}
    </div>
  );
}

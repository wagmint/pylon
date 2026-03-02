import type { DashboardState } from "./types";

export type AlertSeverity = "red" | "blue" | "yellow" | "green";

export interface HexcoreAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  timestamp: string;
}

const RECENT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export function deriveAlerts(state: DashboardState): HexcoreAlert[] {
  const alerts: HexcoreAlert[] = [];
  const now = Date.now();

  // Red: file collisions
  for (const collision of state.collisions) {
    const agentNames = collision.agents.map((a) => a.label).join(", ");
    alerts.push({
      id: `collision-${collision.id}`,
      severity: "red",
      title: "File collision",
      detail: `${collision.filePath} — ${agentNames}`,
      timestamp: collision.detectedAt,
    });
  }

  // Blue: agents waiting on user permission approval
  for (const agent of state.agents) {
    if (agent.isActive && agent.status === "blocked") {
      alerts.push({
        id: `blocked-${agent.sessionId}`,
        severity: "blue",
        title: "Needs approval",
        detail: `${agent.label} is waiting for you`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Red/Yellow: spinning signals from agents
  // Only alert on high-confidence patterns — skip file_churn and repeated_tool
  // which fire too easily during normal work.
  const ALERT_PATTERNS = new Set(["stalled", "error_loop", "stuck"]);

  for (const agent of state.agents) {
    if (!agent.isActive) continue;

    for (const signal of agent.risk.spinningSignals) {
      if (!ALERT_PATTERNS.has(signal.pattern)) continue;

      if (signal.level === "critical") {
        alerts.push({
          id: `spin-critical-${agent.sessionId}-${signal.pattern}`,
          severity: "red",
          title: signal.pattern === "stalled"
            ? "Agent critically stalled"
            : "Agent stuck",
          detail: `${agent.label} — ${signal.detail}`,
          timestamp: new Date().toISOString(),
        });
      } else if (signal.level === "elevated") {
        alerts.push({
          id: `spin-${agent.sessionId}-${signal.pattern}`,
          severity: "yellow",
          title: signal.pattern === "stalled"
            ? "Agent stalling"
            : "Agent error loop",
          detail: `${agent.label} — ${signal.detail}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // Green: recent positive feed events
  for (const event of state.feed) {
    const eventTime = new Date(event.timestamp).getTime();
    if (now - eventTime > RECENT_WINDOW_MS) continue;

    if (event.type === "session_ended") {
      alerts.push({
        id: `feed-${event.id}`,
        severity: "green",
        title: "Agent finished",
        detail: `${event.agentLabel} completed work`,
        timestamp: event.timestamp,
      });
    } else if (event.type === "plan_approved") {
      alerts.push({
        id: `feed-${event.id}`,
        severity: "green",
        title: "Plan approved",
        detail: `${event.agentLabel} started implementation`,
        timestamp: event.timestamp,
      });
    }
  }

  // Sort: red first, then yellow, then green; within same severity, newest first
  const severityOrder: Record<AlertSeverity, number> = {
    red: 0,
    blue: 1,
    yellow: 2,
    green: 3,
  };
  alerts.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return alerts;
}

export type TraySeverity = AlertSeverity | "grey";

export function worstSeverity(
  alerts: HexcoreAlert[],
  state: DashboardState,
): TraySeverity {
  const active = state.agents.filter((a) => a.isActive);
  if (active.some((a) => a.status === "conflict") || alerts.some((a) => a.severity === "red")) return "red";
  if (active.some((a) => a.status === "blocked") || alerts.some((a) => a.severity === "blue")) return "blue";
  if (active.some((a) => a.status === "warning") || alerts.some((a) => a.severity === "yellow")) return "yellow";
  if (active.some((a) => a.status === "busy")) return "green";
  return "grey";
}

import type { DashboardState } from "./types";

export type AlertSeverity = "red" | "yellow" | "blue" | "green";

export interface HexcoreAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  timestamp: string;
  collisionId?: string;
  blockedItems?: Array<{ toolName: string; description: string; detail?: string }>;
}

const RECENT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export function deriveAlerts(state: DashboardState): HexcoreAlert[] {
  const alerts: HexcoreAlert[] = [];
  const now = Date.now();

  // Blue: agents waiting on user permission approval
  for (const agent of state.agents) {
    if (agent.isActive && agent.status === "blocked") {
      const items = agent.blockedOn ?? [];
      let detail: string;
      if (items.length === 0) {
        detail = `${agent.label} is waiting for you`;
      } else if (items.length === 1) {
        detail = `${agent.label}: ${items[0].description}`;
      } else {
        detail = `${agent.label}: ${items.length} tools waiting for approval`;
      }
      alerts.push({
        id: `blocked-${agent.sessionId}`,
        severity: "blue",
        title: "Needs approval",
        detail,
        timestamp: new Date().toISOString(),
        blockedItems: items.length > 0
          ? items.map(i => ({ toolName: i.toolName, description: i.description, detail: i.detail }))
          : undefined,
      });
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

  // Sort: red > yellow > blue > green; within same severity, newest first
  const severityOrder: Record<AlertSeverity, number> = {
    red: 0,
    yellow: 1,
    blue: 2,
    green: 3,
  };
  alerts.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return alerts;
}

export type TraySeverity = "red" | "yellow" | "green" | "blue" | "grey";

export function worstSeverity(
  alerts: HexcoreAlert[],
  state: DashboardState,
): TraySeverity {
  if (alerts.some(a => a.severity === "red")) return "red";
  if (alerts.some(a => a.severity === "yellow")) return "yellow";
  const active = state.agents.filter((a) => a.isActive);
  if (active.some((a) => a.status === "blocked")) return "blue";
  if (active.some((a) => a.status === "busy")) return "green";
  return "grey";
}

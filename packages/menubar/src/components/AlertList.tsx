import { useState } from "react";
import type { HexcoreAlert } from "../lib/alerts";

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

const severityStyles = {
  red: {
    bg: "bg-dash-red/8",
    border: "border-dash-red/20",
    dot: "bg-dash-red",
    title: "text-dash-red",
  },
  blue: {
    bg: "bg-dash-blue/8",
    border: "border-dash-blue/20",
    dot: "bg-dash-blue",
    title: "text-dash-blue",
  },
  yellow: {
    bg: "bg-dash-yellow/8",
    border: "border-dash-yellow/20",
    dot: "bg-dash-yellow",
    title: "text-dash-yellow",
  },
  green: {
    bg: "bg-dash-green/8",
    border: "border-dash-green/20",
    dot: "bg-dash-green",
    title: "text-dash-green",
  },
};

function AlertItem({ alert }: { alert: HexcoreAlert }) {
  const style = severityStyles[alert.severity];
  const isBlocked = alert.severity === "blue" && alert.id.startsWith("blocked-");
  const sessionId = isBlocked ? alert.id.slice("blocked-".length) : null;
  const [deciding, setDeciding] = useState(false);

  async function handleDecide(action: "approve" | "deny") {
    if (!sessionId) return;
    setDeciding(true);
    try {
      await fetch(`http://localhost:7433/api/sessions/${sessionId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch { /* server down */ }
    setDeciding(false);
  }

  return (
    <div className={`${style.bg} ${style.border} border rounded-lg px-3 py-2`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`w-1.5 h-1.5 rounded-full ${style.dot} ${
              alert.severity === "red" ? "animate-dash-pulse" : alert.severity === "blue" ? "animate-dash-breathe" : ""
            }`}
          />
          <span className={`text-xs font-medium ${style.title}`}>
            {alert.title}
          </span>
        </div>
        {isBlocked ? (
          <div className="flex items-center gap-1">
            <button
              disabled={deciding}
              onClick={() => handleDecide("approve")}
              className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-dash-green/15 text-dash-green hover:bg-dash-green/25 transition-colors disabled:opacity-50"
            >
              Approve <span className="opacity-50">↵</span>
            </button>
            <button
              disabled={deciding}
              onClick={() => handleDecide("deny")}
              className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-dash-red/15 text-dash-red hover:bg-dash-red/25 transition-colors disabled:opacity-50"
            >
              Deny
            </button>
          </div>
        ) : (
          <span className="text-[10px] text-dash-text-muted">
            {timeAgo(alert.timestamp)}
          </span>
        )}
      </div>
      {alert.blockedItems && alert.blockedItems.length > 0 ? (
        <div className="mt-1 pl-3.5 space-y-0.5">
          {alert.blockedItems.slice(0, 3).map((item, i) => (
            <div key={i} className="flex items-baseline gap-1.5 min-w-0">
              <span className="text-[10px] text-dash-text-muted flex-shrink-0">
                {item.toolName}
              </span>
              <span className="text-[11px] text-dash-text-dim font-mono truncate">
                {item.detail || item.description}
              </span>
            </div>
          ))}
          {alert.blockedItems.length > 3 && (
            <span className="text-[10px] text-dash-text-muted">
              +{alert.blockedItems.length - 3} more
            </span>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-dash-text-dim mt-1 pl-3.5 truncate">
          {alert.detail}
        </p>
      )}
    </div>
  );
}

interface AlertListProps {
  alerts: HexcoreAlert[];
}

export function AlertList({ alerts }: AlertListProps) {
  const criticalAlerts = alerts.filter(
    (a) => a.severity === "red" || a.severity === "blue" || a.severity === "yellow",
  );
  const infoAlerts = alerts.filter((a) => a.severity === "green");

  if (alerts.length === 0) return null;

  return (
    <div className="px-3 py-2">
      {criticalAlerts.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
            Alerts
          </span>
          {criticalAlerts.map((alert) => (
            <AlertItem key={alert.id} alert={alert} />
          ))}
        </div>
      )}

      {infoAlerts.length > 0 && (
        <div className={`space-y-1 ${criticalAlerts.length > 0 ? "mt-2" : ""}`}>
          <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
            Recent
          </span>
          {infoAlerts.slice(0, 5).map((alert) => {
            const style = severityStyles[alert.severity];
            return (
              <div
                key={alert.id}
                className="flex items-center justify-between px-3 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${style.dot}`}
                  />
                  <span className="text-xs text-dash-text-dim">
                    {alert.title}
                  </span>
                  <span className="text-[11px] text-dash-text-muted truncate max-w-[180px]">
                    {alert.detail}
                  </span>
                </div>
                <span className="text-[10px] text-dash-text-muted flex-shrink-0">
                  {timeAgo(alert.timestamp)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

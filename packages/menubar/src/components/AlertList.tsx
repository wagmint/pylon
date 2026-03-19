import { useRef, useState } from "react";
import type { HexcoreAlert } from "../lib/alerts";
import { DecideButtons } from "./DecideButtons";

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

const severityStyles: Record<string, { bg: string; border: string; dot: string; title: string }> = {
  red: {
    bg: "bg-red-500/8",
    border: "border-red-500/20",
    dot: "bg-red-500",
    title: "text-red-400",
  },
  yellow: {
    bg: "bg-yellow-500/8",
    border: "border-yellow-500/20",
    dot: "bg-yellow-500",
    title: "text-yellow-400",
  },
  blue: {
    bg: "bg-dash-blue/8",
    border: "border-dash-blue/20",
    dot: "bg-dash-blue",
    title: "text-dash-blue",
  },
  green: {
    bg: "bg-dash-green/8",
    border: "border-dash-green/20",
    dot: "bg-dash-green",
    title: "text-dash-green",
  },
};

function AlertItem({ alert, onDecided }: { alert: HexcoreAlert; onDecided?: (alertId: string) => void }) {
  const style = severityStyles[alert.severity] ?? severityStyles.blue;
  const isBlocked = alert.severity === "blue" && alert.id.startsWith("blocked-");
  const sessionId = isBlocked ? alert.id.slice("blocked-".length) : null;

  return (
    <div className={`${style.bg} ${style.border} border rounded-lg px-3 py-2`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`w-1.5 h-1.5 rounded-full ${style.dot} ${
              alert.severity === "blue" ? "animate-dash-breathe"
              : alert.severity === "red" ? "animate-dash-pulse"
              : alert.severity === "yellow" ? "animate-dash-breathe"
              : ""
            }`}
          />
          <span className={`text-xs font-medium ${style.title}`}>
            {alert.title}
          </span>
        </div>
        {isBlocked && sessionId ? (
          <DecideButtons
            sessionId={sessionId}
            itemCount={alert.blockedItems?.length}
            showEnterHint
            size="xs"
            onDecided={() => onDecided?.(alert.id)}
          />
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
  const holdRef = useRef<Map<string, HexcoreAlert>>(new Map());
  const [, bump] = useState(0);

  function onAlertDecided(alertId: string) {
    const alert = alerts.find((a) => a.id === alertId);
    if (alert) {
      holdRef.current.set(alertId, alert);
      setTimeout(() => {
        holdRef.current.delete(alertId);
        bump((n) => n + 1);
      }, 600);
    }
  }

  // Merge held alerts so they stay visible during grace period
  const allAlerts = [...alerts];
  for (const [id, alert] of holdRef.current) {
    if (!allAlerts.some((a) => a.id === id)) {
      allAlerts.push(alert);
    }
  }

  const criticalAlerts = allAlerts.filter(
    (a) => a.severity === "red" || a.severity === "yellow" || a.severity === "blue",
  );
  const infoAlerts = allAlerts.filter((a) => a.severity === "green");

  if (allAlerts.length === 0) return null;

  return (
    <div className="px-3 py-2">
      {criticalAlerts.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
            Alerts
          </span>
          {criticalAlerts.map((alert) => (
            <AlertItem key={alert.id} alert={alert} onDecided={onAlertDecided} />
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

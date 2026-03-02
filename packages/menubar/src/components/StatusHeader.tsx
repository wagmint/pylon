import type { TraySeverity } from "../lib/alerts";

const hexColor: Record<TraySeverity, string> = {
  green: "var(--dash-green)",
  yellow: "var(--dash-yellow)",
  red: "var(--dash-red)",
  blue: "var(--dash-blue)",
  grey: "var(--dash-text-muted)",
};

const pulseClass: Record<TraySeverity, string> = {
  red: "animate-dash-pulse",
  blue: "animate-dash-breathe",
  yellow: "",
  green: "",
  grey: "",
};

interface StatusHeaderProps {
  severity: TraySeverity;
  agentCount: number;
  connected: boolean;
  onClose?: () => void;
}

export function StatusHeader({
  severity,
  agentCount,
  connected,
  onClose,
}: StatusHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-dash-border">
      <div className="flex items-center gap-2.5 min-w-0">
        {onClose && (
          <button
            onClick={onClose}
            className="text-dash-text-muted hover:text-dash-text transition-colors text-sm leading-none w-5 h-5 rounded hover:bg-dash-surface-2"
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        )}
        <div className="flex items-center gap-2.5">
          <svg
            width="16"
            height="16"
            viewBox="0 0 44 44"
            className={pulseClass[severity]}
          >
            <polygon
              points="22,3 38.5,12.5 38.5,31.5 22,41 5.5,31.5 5.5,12.5"
              fill="none"
              stroke={hexColor[severity]}
              strokeWidth="1.5"
              opacity="0.8"
            />
            <polygon
              points="22,11 31.5,16.5 31.5,27.5 22,33 12.5,27.5 12.5,16.5"
              fill={hexColor[severity]}
            />
          </svg>
          <span className="text-sm font-semibold text-dash-text">Hexdeck</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-dash-text-dim">
          {agentCount} agent{agentCount !== 1 ? "s" : ""}
        </span>
        {!connected && (
          <span className="text-[10px] text-dash-red font-medium">
            disconnected
          </span>
        )}
      </div>
    </div>
  );
}

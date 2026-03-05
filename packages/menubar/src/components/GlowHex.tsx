import type { TraySeverity } from "../lib/alerts";

const glowColor: Record<TraySeverity, string> = {
  green: "#00e87b",
  blue: "#4d9fff",
  grey: "#9090a8",
};

const pulseClass: Record<TraySeverity, string> = {
  blue: "animate-dash-breathe",
  green: "",
  grey: "animate-dash-idle-breathe",
};

interface GlowHexProps {
  severity: TraySeverity;
  size: number; // tailwind w-/h- value in units of 4 (e.g. 4 → w-4 h-4 = 16px)
  className?: string;
}

export function GlowHex({ severity, size, className = "" }: GlowHexProps) {
  const color = glowColor[severity];
  const px = size * 4;

  return (
    <div
      className={`relative flex-shrink-0 ${pulseClass[severity]} ${className}`}
      style={{ width: px, height: px }}
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full">
        <defs>
          <filter id={`gh-${severity}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id={`ghg-${severity}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={color} stopOpacity={severity === "grey" ? "0.9" : "0.8"} />
            <stop offset="60%" stopColor={color} stopOpacity={severity === "grey" ? "0.35" : "0.2"} />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </radialGradient>

          {severity === "grey" && (
            <>
              <filter id="gh-grey-backlight" x="-150%" y="-150%" width="400%" height="400%">
                <feGaussianBlur stdDeviation="14" />
              </filter>
              <filter id="gh-grey-backlight-outer" x="-150%" y="-150%" width="400%" height="400%">
                <feGaussianBlur stdDeviation="25" />
              </filter>
              <filter id="gh-grey-edge" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="4" result="edge-blur" />
                <feFlood floodColor="#ffffff" floodOpacity="0.6" result="white" />
                <feComposite in="white" in2="edge-blur" operator="in" result="white-edge" />
                <feGaussianBlur in="white-edge" stdDeviation="3" result="edge-glow" />
                <feMerge>
                  <feMergeNode in="edge-glow" />
                  <feMergeNode in="edge-glow" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <radialGradient id="ghg-grey-backlight" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
                <stop offset="25%" stopColor="#e0e0f0" stopOpacity="0.5" />
                <stop offset="55%" stopColor="#c0c0d0" stopOpacity="0.2" />
                <stop offset="100%" stopColor="#c0c0d0" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="ghg-grey-backlight-outer" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.3" />
                <stop offset="50%" stopColor="#c0c0d0" stopOpacity="0.1" />
                <stop offset="100%" stopColor="#c0c0d0" stopOpacity="0" />
              </radialGradient>
            </>
          )}
        </defs>
        {severity === "grey" && (
          <>
            <circle
              cx="50"
              cy="50"
              r="48"
              fill="url(#ghg-grey-backlight-outer)"
              filter="url(#gh-grey-backlight-outer)"
            />
            <circle
              cx="50"
              cy="50"
              r="40"
              fill="url(#ghg-grey-backlight)"
              filter="url(#gh-grey-backlight)"
            />
          </>
        )}
        <circle cx="50" cy="50" r="36" fill={`url(#ghg-${severity})`} />
        <polygon
          points="50,8 92,29 92,71 50,92 8,71 8,29"
          fill="none"
          stroke={severity === "grey" ? "#b0b0c8" : color}
          strokeWidth={severity === "grey" ? "2.5" : "2"}
          filter={severity === "grey" ? "url(#gh-grey-edge)" : `url(#gh-${severity})`}
        />
        <polygon
          points="50,32 68,42 68,58 50,68 32,58 32,42"
          fill={color}
          filter={severity === "grey" ? "url(#gh-grey-edge)" : `url(#gh-${severity})`}
        />
      </svg>
    </div>
  );
}

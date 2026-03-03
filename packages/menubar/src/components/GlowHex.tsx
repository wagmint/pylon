import type { TraySeverity } from "../lib/alerts";

const glowColor: Record<TraySeverity, string> = {
  green: "#00e87b",
  blue: "#4d9fff",
  grey: "#4a4a5e",
};

const pulseClass: Record<TraySeverity, string> = {
  blue: "animate-dash-breathe",
  green: "",
  grey: "",
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
            <stop offset="0%" stopColor={color} stopOpacity="0.8" />
            <stop offset="60%" stopColor={color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="36" fill={`url(#ghg-${severity})`} />
        <polygon
          points="50,8 92,29 92,71 50,92 8,71 8,29"
          fill="none"
          stroke={color}
          strokeWidth="2"
          filter={`url(#gh-${severity})`}
        />
        <polygon
          points="50,32 68,42 68,58 50,68 32,58 32,42"
          fill={color}
          filter={`url(#gh-${severity})`}
        />
      </svg>
    </div>
  );
}

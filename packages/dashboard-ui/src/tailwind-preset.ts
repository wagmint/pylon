/**
 * Tailwind CSS preset for the Hexdeck dashboard theme.
 * Consuming apps should add this to their tailwind.config.ts:
 *
 *   import hexdeckPreset from "@hexdeck/dashboard-ui/tailwind-preset";
 *   export default { presets: [hexdeckPreset], ... }
 */
export default {
  theme: {
    extend: {
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["DM Sans", "Inter", "system-ui", "sans-serif"],
      },
      colors: {
        dash: {
          bg: "var(--dash-bg)",
          surface: "var(--dash-surface)",
          "surface-2": "var(--dash-surface-2)",
          "surface-3": "var(--dash-surface-3)",
          border: "var(--dash-border)",
          "border-light": "var(--dash-border-light)",
          text: "var(--dash-text)",
          "text-dim": "var(--dash-text-dim)",
          "text-muted": "var(--dash-text-muted)",
          green: "var(--dash-green)",
          "green-dim": "var(--dash-green-dim)",
          red: "var(--dash-red)",
          "red-dim": "var(--dash-red-dim)",
          yellow: "var(--dash-yellow)",
          "yellow-dim": "var(--dash-yellow-dim)",
          blue: "var(--dash-blue)",
          "blue-dim": "var(--dash-blue-dim)",
          purple: "var(--dash-purple)",
          "purple-dim": "var(--dash-purple-dim)",
        },
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "dash-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
        "conflict-flash": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.3" },
        },
        "dash-breathe": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "flash-in": {
          from: { background: "var(--dash-green-dim)" },
          to: { background: "transparent" },
        },
        "decide-morph": {
          from: { opacity: "0", transform: "scale(0)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.3s ease-out",
        "dash-pulse": "dash-pulse 1.5s infinite",
        "conflict-flash": "conflict-flash 0.8s infinite",
        "dash-breathe": "dash-breathe 3.5s ease-in-out infinite",
        "flash-in": "flash-in 1.5s ease-out",
        "decide-morph": "decide-morph 0.2s ease-out",
      },
    },
  },
};

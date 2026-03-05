import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
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
      animation: {
        "fade-in": "fade-in 0.15s ease-out",
        "dash-pulse": "dash-pulse 1.5s infinite",
        "dash-breathe": "dash-breathe 3.5s ease-in-out infinite",
        "dash-idle-breathe": "dash-idle-breathe 5s ease-in-out infinite",
        "tooltip-in": "tooltip-in 0.3s ease-out",
        "slide-in-right": "slide-in-right 0.25s ease-out",
        "slide-in-left": "slide-in-left 0.25s ease-out",
        "decide-morph": "decide-morph 0.2s ease-out",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "dash-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
        "dash-breathe": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "dash-idle-breathe": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.65" },
        },
        "tooltip-in": {
          from: { opacity: "0", transform: "translateX(8px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(24px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-24px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "decide-morph": {
          from: { opacity: "0", transform: "scale(0)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;

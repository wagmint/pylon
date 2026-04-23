import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "../dashboard-ui/dist/**/*.{js,mjs}",
  ],
  safelist: [
    "bg-dash-green", "bg-dash-green-dim",
    "bg-dash-yellow", "bg-dash-yellow-dim",
    "bg-dash-red", "bg-dash-red-dim",
    "bg-dash-blue", "bg-dash-blue-dim",
    "bg-dash-purple", "bg-dash-purple-dim",
    "text-dash-green", "text-dash-yellow", "text-dash-red",
    "border-dash-green/30", "border-dash-blue/30",
    "bg-dash-green/10", "bg-dash-blue/10",
    "bg-dash-red/5", "bg-dash-yellow/5", "bg-dash-blue/5",
    "border-dash-red/20", "border-dash-yellow/20", "border-dash-blue/20",
    "border-l-dash-red", "border-l-dash-yellow", "border-l-dash-blue",
    "border-l-dash-green", "border-l-dash-border",
    "ring-dash-border-light",
    "bg-dash-red/3", "border-dash-red/30",
  ],
  theme: {
    extend: {
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["DM Sans", "Inter", "system-ui", "sans-serif"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        node: {
          user: "hsl(var(--node-user))",
          commit: "hsl(var(--node-commit))",
          error: "hsl(var(--node-error))",
          compaction: "hsl(var(--node-compaction))",
          default: "hsl(var(--node-default))",
        },
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
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        soft: "0 2px 8px -2px hsl(220 20% 10% / 0.1)",
        card: "0 1px 3px hsl(220 20% 10% / 0.06), 0 4px 12px hsl(220 20% 10% / 0.08)",
        elevated: "0 8px 32px -8px hsl(220 20% 10% / 0.15)",
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
        "flash-in": {
          from: { background: "var(--dash-green-dim)" },
          to: { background: "transparent" },
        },
        "loading-slide": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.3s ease-out",
        "dash-pulse": "dash-pulse 1.5s infinite",
        "conflict-flash": "conflict-flash 0.8s infinite",
        "flash-in": "flash-in 1.5s ease-out",
        "loading-slide": "loading-slide 1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;

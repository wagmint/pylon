export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(n: number): string {
  if (!n || isNaN(n)) return "$0";
  if (n < 0.01) return "$0";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

export function shortModelName(model: string): string {
  const l = model.toLowerCase();
  if (l.startsWith("claude-opus-4-7")) return "Opus 4.7";
  if (l.startsWith("claude-opus-4-6")) return "Opus 4.6";
  if (l.startsWith("claude-opus-4-5")) return "Opus 4.5";
  if (l.startsWith("claude-opus-4-1")) return "Opus 4.1";
  if (l.startsWith("claude-opus-4")) return "Opus 4";
  if (l.startsWith("claude-sonnet-4-6")) return "Sonnet 4.6";
  if (l.startsWith("claude-sonnet-4-5")) return "Sonnet 4.5";
  if (l.startsWith("claude-sonnet-4")) return "Sonnet 4";
  if (l.startsWith("claude-sonnet-3")) return "Sonnet 3.5";
  if (l.startsWith("claude-haiku-4-5")) return "Haiku 4.5";
  if (l.startsWith("claude-haiku-3")) return "Haiku 3.5";
  if (l.startsWith("gpt-5.3-codex")) return "GPT-5.3 Codex";
  if (l.startsWith("gpt-5.2-codex")) return "GPT-5.2 Codex";
  if (l.startsWith("gpt-5.1-codex-mini")) return "Codex Mini 5.1";
  if (l.startsWith("gpt-5.1-codex")) return "Codex 5.1";
  if (l.startsWith("gpt-5-codex")) return "Codex 5";
  if (l.startsWith("codex-mini")) return "Codex Mini";
  if (l.startsWith("o4-mini")) return "o4-mini";
  if (l.startsWith("o3-mini")) return "o3-mini";
  return model;
}

export function formatDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

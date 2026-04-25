import { readdirSync, statSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import type { SessionInfo } from "../types/index.js";
import { normalizeProjectPath } from "../core/git-state.js";
import { readCodexSessionMeta } from "../parser/codex.js";

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

// ─── Meta cache — avoids re-reading first line on every poll cycle ──────────

const metaCache = new Map<string, { mtimeMs: number; meta: { id: string; cwd: string } }>();

function getCachedMeta(filePath: string, mtimeMs: number): { id: string; cwd: string } | null {
  const cached = metaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;

  const meta = readCodexSessionMeta(filePath);
  if (meta) {
    metaCache.set(filePath, { mtimeMs, meta });
  }
  return meta;
}

// ─── Session discovery ──────────────────────────────────────────────────────

/**
 * Discover Codex sessions from ~/.codex/sessions/ within a recency window.
 * Directory structure: YYYY/MM/DD/rollout-*.jsonl
 * @param recencyDays How many days back to look (default 7)
 * @param codexDir Optional alternative .codex directory root (defaults to ~/.codex)
 */
export function discoverCodexSessions(recencyDays = 7, codexDir?: string): SessionInfo[] {
  const sessionsDir = codexDir ? join(codexDir, "sessions") : CODEX_SESSIONS_DIR;
  if (!existsSync(sessionsDir)) return [];

  const sessions: SessionInfo[] = [];
  const cutoff = Date.now() - recencyDays * 24 * 60 * 60 * 1000;

  try {
    // Walk YYYY directories
    const years = safeReaddir(sessionsDir);
    for (const year of years) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearDir = join(sessionsDir, year);

      // Walk MM directories
      const months = safeReaddir(yearDir);
      for (const month of months) {
        if (!/^\d{2}$/.test(month)) continue;
        const monthDir = join(yearDir, month);

        // Walk DD directories
        const days = safeReaddir(monthDir);
        for (const day of days) {
          if (!/^\d{2}$/.test(day)) continue;
          const dayDir = join(monthDir, day);

          // Quick date check: skip entire day dirs older than recency
          const dirDate = new Date(`${year}-${month}-${day}T23:59:59`);
          if (dirDate.getTime() < cutoff) continue;

          // Find rollout-*.jsonl files
          const files = safeReaddir(dayDir);
          for (const file of files) {
            if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;

            const filePath = join(dayDir, file);
            try {
              const stat = statSync(filePath);
              if (stat.mtimeMs < cutoff) continue;

              const meta = getCachedMeta(filePath, stat.mtimeMs);
              if (!meta) continue;

              sessions.push({
                id: meta.id,
                path: filePath,
                projectPath: normalizeProjectPath(meta.cwd, filePath),
                createdAt: stat.birthtime,
                modifiedAt: stat.mtime,
                sizeBytes: stat.size,
              });
            } catch {
              // Skip unreadable files
            }
          }
        }
      }
    }
  } catch {
    // Base dir access failure
  }

  return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

// ─── Active detection ───────────────────────────────────────────────────────

/**
 * Get currently active Codex sessions by finding running `codex` CLI processes
 * and matching their working directories to discovered session files.
 */
export function getActiveCodexSessions(): SessionInfo[] {
  if (!existsSync(CODEX_SESSIONS_DIR)) return [];

  try {
    const pids = execSync(
      `pgrep -f '(^|/)codex( |$)' 2>/dev/null || true`,
      { encoding: "utf-8", timeout: 3000 }
    ).trim();

    if (!pids) return [];

    const pidList = pids.split("\n").filter(Boolean).join(",");
    const output = execSync(
      `lsof -p ${pidList} -Fn 2>/dev/null || true`,
      { encoding: "utf-8", timeout: 5000 }
    );

    if (!output.trim()) return [];

    // Parse lsof output — same pattern as Claude discovery
    const cwdPids = new Map<string, Set<string>>();
    const lines = output.split("\n");
    let currentPid: string | null = null;
    let isCwd = false;

    for (const line of lines) {
      if (line.startsWith("p")) {
        currentPid = line.slice(1);
      } else if (line === "fcwd") {
        isCwd = true;
      } else if (isCwd && line.startsWith("n")) {
        const path = line.slice(1);
        if (path.startsWith("/") && !path.includes(".app/") && currentPid) {
          if (!cwdPids.has(path)) cwdPids.set(path, new Set());
          cwdPids.get(path)!.add(currentPid);
        }
        isCwd = false;
      } else if (line.startsWith("f")) {
        isCwd = false;
      }
    }

    if (cwdPids.size === 0) return [];

    // Discover sessions — no recency limit for active matching
    const allSessions = discoverCodexSessions(365);
    const activeSessions: SessionInfo[] = [];
    const seenCwds = new Set<string>();

    for (const [cwd, pids] of cwdPids) {
      if (seenCwds.has(cwd)) continue;
      seenCwds.add(cwd);

      // Find sessions whose projectPath matches this cwd
      const matching = allSessions.filter((s) => s.projectPath === cwd);
      if (matching.length === 0) continue;

      // Take N most recent sessions where N = number of active processes
      const count = Math.min(pids.size, matching.length);
      for (let i = 0; i < count; i++) {
        activeSessions.push(matching[i]);
      }
    }

    return activeSessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  } catch {
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

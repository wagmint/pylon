import { readFileSync, statSync } from "fs";
import { parseSessionFileFromContent, parseSystemLinesFromContent } from "../parser/jsonl.js";
import { parseCodexSessionFile } from "../parser/codex.js";
import { buildParsedSession } from "./nodes.js";
import { buildCodexParsedSession } from "./codex-nodes.js";
import { buildSessionPlans } from "./plans.js";
import type {
  ParsedSession, SessionInfo, SessionPlan, TokenUsage,
} from "../types/index.js";

// ─── In-memory parse cache ──────────────────────────────────────────────────

interface CacheEntry {
  mtimeMs: number;
  parsed: ParsedSession;
}

const parseCache = new Map<string, CacheEntry>();

// ─── Session accumulator — survives compaction ──────────────────────────────

export interface SessionAccumulator {
  totalTurns: number;
  totalToolCalls: number;
  totalCommits: number;
  totalCompactions: number;
  totalErrorTurns: number;
  totalCorrectionTurns: number;
  totalTokenUsage: TokenUsage;
  filesChanged: Set<string>;
  toolsUsed: Record<string, number>;
  primaryModel: string | null;
  plans: SessionPlan[];
  errorHistory: boolean[];
  modelUsage: Map<string, { source: "claude" | "codex"; tokens: number; turns: number }>;
}

const accumulators = new Map<string, SessionAccumulator>();

// ─── Accumulator helpers ─────────────────────────────────────────────────────

function maxTokenUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return { ...b };
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadInputTokens: Math.max(a.cacheReadInputTokens, b.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
  };
}

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

function unionSets(a: Set<string> | undefined, b: Set<string>): Set<string> {
  if (!a) return new Set(b);
  return new Set([...a, ...b]);
}

function mergeToolsUsed(
  a: Record<string, number> | undefined,
  b: Record<string, number>
): Record<string, number> {
  if (!a) return { ...b };
  const merged = { ...a };
  for (const [tool, count] of Object.entries(b)) {
    merged[tool] = Math.max(merged[tool] ?? 0, count);
  }
  return merged;
}

function updateAccumulator(sessionId: string, parsed: ParsedSession): void {
  const prev = accumulators.get(sessionId);
  const { stats } = parsed;

  const source = parsed.session.path.includes("/.codex/") ? "codex" : "claude";
  const currentModelUsage = new Map<string, { source: "claude" | "codex"; tokens: number; turns: number }>();
  for (const turn of parsed.turns) {
    const tokenCount = turn.tokenUsage.inputTokens
      + turn.tokenUsage.outputTokens
      + turn.tokenUsage.cacheReadInputTokens
      + turn.tokenUsage.cacheCreationInputTokens;
    if (turn.model) {
      const entry = currentModelUsage.get(turn.model) ?? { source, tokens: 0, turns: 0 };
      entry.tokens += tokenCount;
      entry.turns += 1;
      currentModelUsage.set(turn.model, entry);
    }
  }
  const mergedModelUsage = new Map(prev?.modelUsage ?? new Map());
  for (const [model, data] of currentModelUsage) {
    const prevData = mergedModelUsage.get(model);
    if (!prevData || data.tokens > prevData.tokens) {
      mergedModelUsage.set(model, data);
    }
  }

  const acc: SessionAccumulator = {
    totalTurns: Math.max(prev?.totalTurns ?? 0, stats.totalTurns),
    totalToolCalls: Math.max(prev?.totalToolCalls ?? 0, stats.toolCalls),
    totalCommits: Math.max(prev?.totalCommits ?? 0, stats.commits),
    totalCompactions: Math.max(prev?.totalCompactions ?? 0, stats.compactions),
    totalErrorTurns: Math.max(prev?.totalErrorTurns ?? 0, stats.errorTurns),
    totalCorrectionTurns: Math.max(prev?.totalCorrectionTurns ?? 0, stats.correctionTurns),
    totalTokenUsage: maxTokenUsage(prev?.totalTokenUsage, stats.totalTokenUsage),
    filesChanged: unionSets(prev?.filesChanged, new Set(stats.filesChanged)),
    toolsUsed: mergeToolsUsed(prev?.toolsUsed, stats.toolsUsed),
    primaryModel: stats.primaryModel ?? prev?.primaryModel ?? null,
    plans: [],
    errorHistory: [],
    modelUsage: mergedModelUsage,
  };

  // Plans: keep all plan cycles; fall back to accumulator if current parse yields nothing
  const currentPlans = buildSessionPlans(parsed, "");
  if (currentPlans.length > 0) {
    acc.plans = currentPlans;
  } else {
    acc.plans = prev?.plans ?? [];
  }

  // Error history: extend on compaction, replace on normal growth
  const prevHistory = prev?.errorHistory ?? [];
  const currentErrors = parsed.turns.map(t => t.hasError);
  if (prev && prev.totalTurns > parsed.turns.length) {
    // Compaction: keep old history, append new post-compaction turns
    acc.errorHistory = [...prevHistory, ...currentErrors];
  } else {
    // Normal: current parse is the full history
    acc.errorHistory = currentErrors;
  }

  accumulators.set(sessionId, acc);
}

function mergeAccumulatorIntoStats(acc: SessionAccumulator, parsed: ParsedSession): void {
  // Compaction: accumulated baseline + post-compaction delta (current parse)
  parsed.stats.totalTurns = acc.totalTurns + parsed.stats.totalTurns;
  parsed.stats.toolCalls = acc.totalToolCalls + parsed.stats.toolCalls;
  parsed.stats.commits = acc.totalCommits + parsed.stats.commits;
  parsed.stats.compactions = acc.totalCompactions; // already counted
  parsed.stats.errorTurns = acc.totalErrorTurns + parsed.stats.errorTurns;
  parsed.stats.correctionTurns = acc.totalCorrectionTurns + parsed.stats.correctionTurns;
  parsed.stats.totalTokenUsage = addTokenUsage(acc.totalTokenUsage, parsed.stats.totalTokenUsage);
  parsed.stats.filesChanged = [...new Set([...acc.filesChanged, ...parsed.stats.filesChanged])];
  parsed.stats.toolsUsed = mergeToolsUsed(acc.toolsUsed, parsed.stats.toolsUsed);
  parsed.stats.primaryModel = parsed.stats.primaryModel ?? acc.primaryModel;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getCachedOrParse(session: SessionInfo): ParsedSession {
  const cached = parseCache.get(session.id);
  let currentMtime: number;

  try {
    currentMtime = statSync(session.path).mtimeMs;
  } catch {
    // File may have been deleted; parse fresh
    currentMtime = 0;
  }

  if (cached && cached.mtimeMs === currentMtime) {
    return cached.parsed;
  }

  const content = readFileSync(session.path, "utf-8");
  const events = parseSessionFileFromContent(content);
  const systemMeta = parseSystemLinesFromContent(content);
  const parsed = buildParsedSession(session, events, systemMeta);

  // Compaction detection: accumulator had more turns than current parse
  const acc = accumulators.get(session.id);
  const isCompaction = acc && acc.totalTurns > parsed.turns.length;

  if (isCompaction) {
    mergeAccumulatorIntoStats(acc, parsed);
  }

  // Always update accumulator to reflect current state
  updateAccumulator(session.id, parsed);

  parseCache.set(session.id, { mtimeMs: currentMtime, parsed });
  return parsed;
}

/** Get the accumulator's prior plans for a session (used for compaction fallback). */
export function getAccumulatorPlans(sessionId: string): SessionPlan[] | undefined {
  return accumulators.get(sessionId)?.plans;
}

/** Get the full accumulator for a session (used by risk computation). */
export function getAccumulator(sessionId: string): SessionAccumulator | undefined {
  return accumulators.get(sessionId);
}

// ─── Codex parse cache (separate from Claude) ───────────────────────────────

const codexParseCache = new Map<string, CacheEntry>();

export function isCodexSession(session: SessionInfo): boolean {
  return session.path.includes("/.codex/");
}

export function getCachedOrParseCodex(session: SessionInfo): ParsedSession {
  const cached = codexParseCache.get(session.id);
  let currentMtime: number;

  try {
    currentMtime = statSync(session.path).mtimeMs;
  } catch {
    currentMtime = 0;
  }

  if (cached && cached.mtimeMs === currentMtime) {
    return cached.parsed;
  }

  const events = parseCodexSessionFile(session.path);
  const parsed = buildCodexParsedSession(session, events);

  codexParseCache.set(session.id, { mtimeMs: currentMtime, parsed });
  return parsed;
}

// ─── Cache GC ────────────────────────────────────────────────────────────────

/** Evict cache entries for sessions no longer in the working set. */
export function evictStaleCacheEntries(liveSessionIds: Set<string>): void {
  for (const id of parseCache.keys()) {
    if (!liveSessionIds.has(id)) parseCache.delete(id);
  }
  for (const id of codexParseCache.keys()) {
    if (!liveSessionIds.has(id)) codexParseCache.delete(id);
  }
  for (const id of accumulators.keys()) {
    if (!liveSessionIds.has(id)) accumulators.delete(id);
  }
}

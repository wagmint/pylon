import { statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
import { getActiveSessions, listProjects, listSessions } from "../discovery/sessions.js";
import { getActiveCodexSessions, discoverCodexSessions } from "../discovery/codex.js";
import { parseSessionFile, parseSystemLines } from "../parser/jsonl.js";
import { parseCodexSessionFile } from "../parser/codex.js";
import { buildParsedSession } from "./nodes.js";
import { buildCodexParsedSession } from "./codex-nodes.js";
import { getUncommittedFiles } from "./collisions.js";
import { buildFeed } from "./feed.js";
import { hasBlockedSession, getBlockedForSession, describeBlockedTool, extractToolDetail, isSessionStopped } from "./blocked.js";
import { formatIdleDuration } from "./duration.js";
import { computeAgentRisk, computeWorkstreamRisk } from "./risk.js";
import { computeTurnCost } from "./pricing.js";
import { resolveCodexBusyIdle } from "./codex-status.js";
import { loadOperatorConfig, getSelfName, operatorId as makeOperatorId, getOperatorColor } from "./config.js";
import type {
  ParsedSession, SessionInfo, Agent, AgentStatus,
  Workstream, WorkstreamMode, DashboardState, DashboardSummary, Operator,
  SessionPlan, PlanStatus, PlanTask, TokenUsage, DraftingActivity, IntentTaskView,
} from "../types/index.js";

// ─── In-memory parse cache ──────────────────────────────────────────────────

interface CacheEntry {
  mtimeMs: number;
  parsed: ParsedSession;
}

const parseCache = new Map<string, CacheEntry>();

// ─── Session accumulator — survives compaction ──────────────────────────────

interface SessionAccumulator {
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
  totalCost: number;
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

const AGENT_NAMES = [
  "neo", "morpheus", "trinity", "oracle", "cypher", "tank", "dozer", "switch",
  "apoc", "mouse", "niobe", "link", "ghost", "zee", "lock", "merovingian",
  "seraph", "sati", "rama", "ajax", "jue", "thadeus", "ballard", "mifune",
  "hamann", "deus", "trainman", "persephone", "keymaker", "architect",
  "jinx", "vi", "caitlyn", "ekko", "jayce", "viktor", "silco", "vander",
  "mel", "heimerdinger", "sevika", "singed", "ambessa", "warwick", "isha",
];

function hashToIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ─── Persistent label store (survives server restarts) ───────────────────────

const HEXDECK_DIR = join(homedir(), ".hexdeck");
const LABELS_PATH = join(HEXDECK_DIR, "labels.json");

interface LabelEntry {
  name: string;
  lastSeen: number; // epoch ms
}

/** In-memory mirror of the disk-backed label store */
let labelStore = new Map<string, LabelEntry>();
let labelStoreLoaded = false;

/** Max age before a label for a dead session gets garbage-collected */
const LABEL_GC_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function loadLabelStore(): void {
  if (labelStoreLoaded) return;
  labelStoreLoaded = true;
  try {
    if (!existsSync(LABELS_PATH)) return;
    const raw = JSON.parse(readFileSync(LABELS_PATH, "utf-8"));
    if (raw && typeof raw === "object") {
      for (const [id, entry] of Object.entries(raw)) {
        if (entry && typeof entry === "object" && "name" in (entry as Record<string, unknown>)) {
          const e = entry as LabelEntry;
          labelStore.set(id, { name: e.name, lastSeen: e.lastSeen ?? 0 });
        }
      }
    }
  } catch {
    // Corrupt file — start fresh
    labelStore = new Map();
  }
}

function saveLabelStore(): void {
  try {
    if (!existsSync(HEXDECK_DIR)) mkdirSync(HEXDECK_DIR, { recursive: true });
    const obj: Record<string, LabelEntry> = {};
    for (const [id, entry] of labelStore) {
      obj[id] = entry;
    }
    writeFileSync(LABELS_PATH, JSON.stringify(obj, null, 2));
  } catch {
    // Non-critical — labels will still work in-memory
  }
}

/**
 * Assign unique short names. Persisted to disk so names survive restarts.
 * Dead sessions' names are reclaimed after LABEL_GC_AGE_MS.
 */
function buildLabelMap(sessionIds: string[]): Map<string, string> {
  loadLabelStore();

  const now = Date.now();
  const currentIds = new Set(sessionIds);

  // 1. Garbage-collect: remove labels for sessions not seen recently
  for (const [id, entry] of labelStore) {
    if (!currentIds.has(id) && now - entry.lastSeen > LABEL_GC_AGE_MS) {
      labelStore.delete(id);
    }
  }

  // 2. Touch all current sessions
  for (const id of sessionIds) {
    const existing = labelStore.get(id);
    if (existing) {
      existing.lastSeen = now;
    }
  }

  // 3. Build the set of names currently in use (only by live or recent sessions)
  const usedNames = new Set<string>();
  for (const entry of labelStore.values()) {
    usedNames.add(entry.name);
  }

  // 4. Assign names to new sessions
  let dirty = false;
  for (const id of sessionIds) {
    if (labelStore.has(id)) continue;

    let idx = hashToIndex(id) % AGENT_NAMES.length;
    let name = AGENT_NAMES[idx];

    // Resolve collisions — try other names first, then add a small suffix
    let attempt = 0;
    while (usedNames.has(name)) {
      attempt++;
      idx = (idx + 1) % AGENT_NAMES.length;
      if (attempt >= AGENT_NAMES.length) {
        const baseName = AGENT_NAMES[hashToIndex(id) % AGENT_NAMES.length];
        let suffix = 2;
        name = `${baseName}-${suffix}`;
        while (usedNames.has(name)) {
          suffix++;
          name = `${baseName}-${suffix}`;
        }
        break;
      }
      name = AGENT_NAMES[idx];
    }

    usedNames.add(name);
    labelStore.set(id, { name, lastSeen: now });
    dirty = true;
  }

  if (dirty) saveLabelStore();

  // 5. Return only the labels for requested session IDs
  const map = new Map<string, string>();
  for (const id of sessionIds) {
    map.set(id, labelStore.get(id)!.name);
  }
  return map;
}

function updateAccumulator(sessionId: string, parsed: ParsedSession): void {
  const prev = accumulators.get(sessionId);
  const { stats } = parsed;

  // Compute current cost from visible turns
  let currentCost = 0;
  for (const turn of parsed.turns) {
    currentCost += computeTurnCost(turn.model, turn.tokenUsage);
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
    totalCost: Math.max(prev?.totalCost ?? 0, currentCost),
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

function getCachedOrParse(session: SessionInfo): ParsedSession {
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

  const events = parseSessionFile(session.path);
  const systemMeta = parseSystemLines(session.path);
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

// ─── Codex parse cache (separate from Claude) ───────────────────────────────

const codexParseCache = new Map<string, CacheEntry>();

function isCodexSession(session: SessionInfo): boolean {
  return session.path.includes("/.codex/");
}

function getCachedOrParseCodex(session: SessionInfo): ParsedSession {
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

// ─── Plan builder ────────────────────────────────────────────────────────────

function finalizePlan(
  tasks: PlanTask[],
  taskStatuses: Map<string, string>,
  markdown: string | null,
  inPlanMode: boolean,
  planAccepted: boolean,
  planRejected: boolean,
  agentLabel: string,
  timestamp: Date,
  planDurationMs: number | null,
  draftingActivity: DraftingActivity | null,
  postAcceptEdits: boolean,
  postAcceptCommit: boolean,
): SessionPlan | null {
  // Apply final statuses
  for (const task of tasks) {
    const latest = taskStatuses.get(task.id);
    if (latest === "completed" || latest === "in_progress" || latest === "pending" || latest === "deleted") {
      task.status = latest;
    }
  }

  const activeTasks = tasks.filter(t => t.status !== "deleted");

  // Determine status — tasks are the ground truth
  let status: PlanStatus = "none";

  if (activeTasks.length > 0) {
    if (activeTasks.every(t => t.status === "completed")) {
      status = "completed";
    } else if (activeTasks.some(t => t.status === "in_progress" || t.status === "completed")) {
      status = "implementing";
    } else {
      status = "drafting";
    }
  } else if (markdown || inPlanMode || planAccepted || planRejected) {
    if (planRejected) {
      status = "rejected";
    } else if (postAcceptCommit) {
      status = "completed";
    } else if (postAcceptEdits) {
      status = "implementing";
    } else if (inPlanMode || planAccepted || markdown) {
      status = "drafting";
    }
  }

  if (status === "none") return null;

  // Only attach drafting activity when status is "drafting"
  const activity = status === "drafting" ? draftingActivity : null;

  return { status, markdown, tasks: activeTasks, agentLabel, timestamp, planDurationMs, draftingActivity: activity, isFromActiveSession: false };
}

function buildSessionPlans(parsed: ParsedSession, agentLabel: string): SessionPlan[] {
  const finalized: SessionPlan[] = [];

  // Current plan cycle accumulator
  let markdown: string | null = null;
  let planAccepted = false;
  let planRejected = false;
  let inPlanMode = false;
  let lastPlanTs: Date = parsed.session.createdAt;
  let planStartTs: Date | null = null;
  let planDurationMs: number | null = null;
  let tasks: PlanTask[] = [];
  let taskStatuses = new Map<string, string>();

  // Post-acceptance activity signals (for task-less plans)
  let postAcceptEdits = false;
  let postAcceptCommit = false;

  // Drafting activity accumulator
  let draftFiles: Set<string> = new Set();
  let draftSearches: string[] = [];
  let draftToolCounts: Record<string, number> = {};
  let draftApproach = "";
  let draftLastActivity: Date | null = null;
  let draftTurnCount = 0;

  function resetDraftingActivity(): void {
    draftFiles = new Set();
    draftSearches = [];
    draftToolCounts = {};
    draftApproach = "";
    draftLastActivity = null;
    draftTurnCount = 0;
  }

  function buildDraftingActivity(): DraftingActivity | null {
    if (draftTurnCount === 0) return null;
    return {
      filesExplored: [...draftFiles],
      searches: draftSearches,
      toolCounts: { ...draftToolCounts },
      approachSummary: draftApproach,
      lastActivityAt: draftLastActivity!,
      turnCount: draftTurnCount,
    };
  }

  for (const turn of parsed.turns) {
    if (turn.hasPlanStart) {
      // Finalize current plan cycle (if it has any content)
      const plan = finalizePlan(tasks, taskStatuses, markdown, inPlanMode, planAccepted, planRejected, agentLabel, lastPlanTs, planDurationMs, buildDraftingActivity(), postAcceptEdits, postAcceptCommit);
      if (plan) finalized.push(plan);

      // Start fresh cycle
      tasks = [];
      taskStatuses = new Map();
      markdown = null;
      inPlanMode = true;
      planAccepted = false;
      planRejected = false;
      postAcceptEdits = false;
      postAcceptCommit = false;
      lastPlanTs = turn.timestamp;
      planStartTs = turn.timestamp;
      planDurationMs = null;
      resetDraftingActivity();
    }
    if (turn.hasPlanEnd && !turn.planRejected) {
      inPlanMode = false;
      planAccepted = true;
      planRejected = false;
      markdown = turn.planMarkdown ?? markdown;
      lastPlanTs = turn.timestamp;
      if (planStartTs) {
        planDurationMs = turn.timestamp.getTime() - planStartTs.getTime();
      }
    }
    if (turn.hasPlanEnd && turn.planRejected) {
      inPlanMode = false;
      planAccepted = false;
      planRejected = true;
      lastPlanTs = turn.timestamp;
      planDurationMs = null;
    }

    // Accumulate drafting activity while in plan mode
    if (inPlanMode) {
      draftTurnCount++;
      draftLastActivity = turn.timestamp;

      for (const f of turn.filesRead) draftFiles.add(f);

      for (const s of turn.sections.research.searches) draftSearches.push(s);

      for (const [tool, count] of Object.entries(turn.toolCounts)) {
        draftToolCounts[tool] = (draftToolCounts[tool] ?? 0) + count;
      }

      if (turn.sections.approach.summary) {
        draftApproach = turn.sections.approach.summary;
      }
    }

    // Track post-acceptance activity for task-less plans
    // Fires for both ExitPlanMode-accepted plans and planContent-sourced plans
    if ((planAccepted || markdown) && !inPlanMode) {
      if (turn.filesChanged.length > 0) postAcceptEdits = true;
      if (turn.hasCommit) postAcceptCommit = true;
    }

    // Cross-session plan: planMarkdown from JSONL envelope
    if (turn.planMarkdown && !markdown) {
      markdown = turn.planMarkdown;
      lastPlanTs = turn.timestamp;
    }

    for (const tc of turn.taskCreates) {
      if (tc.taskId) {
        tasks.push({
          id: tc.taskId,
          subject: tc.subject,
          description: tc.description,
          status: "pending",
        });
        lastPlanTs = turn.timestamp;
      }
    }

    for (const tu of turn.taskUpdates) {
      taskStatuses.set(tu.taskId, tu.status);
      lastPlanTs = turn.timestamp;
    }
  }

  // Finalize the last plan cycle
  const lastPlan = finalizePlan(tasks, taskStatuses, markdown, inPlanMode, planAccepted, planRejected, agentLabel, lastPlanTs, planDurationMs, buildDraftingActivity(), postAcceptEdits, postAcceptCommit);
  if (lastPlan) finalized.push(lastPlan);

  return finalized;
}

// ─── Intent map helpers ─────────────────────────────────────────────────────

interface IntentInsights {
  intentCoveragePct: number;
  driftPct: number;
  intentConfidence: "high" | "medium" | "low";
  intentStatus: "on_plan" | "drifting" | "blocked" | "no_clear_intent";
  lastIntentUpdateAt: Date | null;
  intentLanes: {
    inProgress: IntentTaskView[];
    done: IntentTaskView[];
    unplanned: IntentTaskView[];
  };
  driftReasons: string[];
}

function buildCanonicalSessionPlans(
  parsed: ParsedSession,
  label: string,
  isActive: boolean,
): SessionPlan[] {
  const sessionAcc = accumulators.get(parsed.session.id);
  let plans = buildSessionPlans(parsed, label);
  if (plans.length === 0 && sessionAcc?.plans?.length) {
    plans = sessionAcc.plans.map((plan) => ({ ...plan, agentLabel: label }));
  }
  return plans.map((plan) => ({ ...plan, isFromActiveSession: isActive }));
}

function hasEvidence(task: IntentTaskView): boolean {
  return task.evidence.edits > 0 || task.evidence.commits > 0 || task.evidence.lastTouchedAt !== null;
}

const INTENT_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "this", "that", "then", "than",
  "task", "work", "update", "fix", "add", "make", "build", "implement", "create",
  "file", "files", "code", "route", "logic", "test", "tests", "use", "using",
]);

function tokenizeIntentText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !INTENT_STOP_WORDS.has(t));
}

function tokenDiceScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const tok of a) {
    if (b.has(tok)) overlap++;
  }
  return (2 * overlap) / (a.size + b.size);
}

function fileNameTokens(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const file = p.split("/").pop() ?? p;
    for (const tok of tokenizeIntentText(file.replace(/\.[a-z0-9]+$/i, ""))) {
      out.add(tok);
    }
  }
  return out;
}

function buildIntentInsights(
  sessions: ParsedSession[],
  allProjectAgents: Agent[],
  plans: SessionPlan[],
  conflictSessionIds: Set<string>,
): IntentInsights {
  const agentBySession = new Map(allProjectAgents.map(a => [a.sessionId, a]));
  const agentByLabel = new Map(allProjectAgents.map(a => [a.label, a]));
  const parsedBySession = new Map(sessions.map(s => [s.session.id, s]));

  const plannedTasks: IntentTaskView[] = [];
  const plannedTaskTokens = new Map<string, Set<string>>();
  const plannedTaskIds = new Set<string>();
  const mappedTurnKeys = new Set<string>();
  const driftReasons: string[] = [];
  const intentUpdateTimes: number[] = [];

  for (const plan of plans) {
    intentUpdateTimes.push(plan.timestamp.getTime());

    const owner = agentByLabel.get(plan.agentLabel) ?? null;
    const ownerSessionId = owner?.sessionId ?? null;
    const parsed = ownerSessionId ? parsedBySession.get(ownerSessionId) : undefined;

    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      if (task.id) plannedTaskIds.add(task.id);

      const linkedTurns = parsed
        ? parsed.turns.filter(t =>
            t.taskCreates.some(tc => tc.taskId && tc.taskId === task.id)
            || t.taskUpdates.some(tu => tu.taskId && tu.taskId === task.id)
          )
        : [];

      let edits = 0;
      let commits = 0;
      let lastTouchedAt: Date | null = null;
      for (const turn of linkedTurns) {
        mappedTurnKeys.add(`${parsed!.session.id}:${turn.index}`);
        edits += turn.filesChanged.length;
        if (turn.hasCommit) commits += 1;
        if (!lastTouchedAt || turn.timestamp.getTime() > lastTouchedAt.getTime()) {
          lastTouchedAt = turn.timestamp;
        }
      }
      if (lastTouchedAt) intentUpdateTimes.push(lastTouchedAt.getTime());

      let state: IntentTaskView["state"];
      if (task.status === "completed") state = "completed";
      else if (task.status === "in_progress") state = "in_progress";
      else state = "pending";
      // Only mark a task blocked when its owning agent is in an active file collision.
      if (state === "in_progress" && ownerSessionId && conflictSessionIds.has(ownerSessionId)) {
        state = "blocked";
      }

      plannedTasks.push({
        id: `planned-${ownerSessionId ?? plan.agentLabel}-${task.id || i}`,
        subject: task.subject || "(untitled task)",
        state,
        ownerLabel: owner?.label ?? plan.agentLabel ?? null,
        ownerSessionId,
        evidence: { edits, commits, lastTouchedAt },
      });
      plannedTaskTokens.set(
        `planned-${ownerSessionId ?? plan.agentLabel}-${task.id || i}`,
        new Set(tokenizeIntentText(task.subject || ""))
      );
    }
  }

  const unplanned: IntentTaskView[] = [];
  let unplannedTurns = 0;
  let fallbackMappedTurns = 0;

  for (const session of sessions) {
    const owner = agentBySession.get(session.session.id);
    for (const turn of session.turns) {
      if (turn.filesChanged.length === 0 && !turn.hasCommit) continue;

      const turnKey = `${session.session.id}:${turn.index}`;
      const hasPlannedTaskLink =
        mappedTurnKeys.has(turnKey)
        || turn.taskCreates.some(tc => tc.taskId && plannedTaskIds.has(tc.taskId))
        || turn.taskUpdates.some(tu => tu.taskId && plannedTaskIds.has(tu.taskId));

      if (hasPlannedTaskLink) continue;

      // Fallback mapping: semantic match by subject/summary/file tokens when taskId is missing.
      const turnText = [turn.summary, turn.commitMessage ?? "", ...turn.filesChanged].join(" ");
      const turnTokens = new Set(tokenizeIntentText(turnText));
      const turnFileTokens = fileNameTokens(turn.filesChanged);
      let bestIdx = -1;
      let bestScore = 0;

      for (let i = 0; i < plannedTasks.length; i++) {
        const task = plannedTasks[i];
        const taskTokens = plannedTaskTokens.get(task.id) ?? new Set<string>();
        const subjectScore = tokenDiceScore(turnTokens, taskTokens);
        const fileScore = tokenDiceScore(turnFileTokens, taskTokens);
        const score = (subjectScore * 0.8) + (fileScore * 0.2);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0 && bestScore >= 0.45) {
        const matched = plannedTasks[bestIdx];
        matched.evidence.edits += turn.filesChanged.length;
        if (turn.hasCommit) matched.evidence.commits += 1;
        if (!matched.evidence.lastTouchedAt || turn.timestamp.getTime() > matched.evidence.lastTouchedAt.getTime()) {
          matched.evidence.lastTouchedAt = turn.timestamp;
        }
        // If explicit task status is still pending but we found implementation evidence, mark as in progress.
        if (matched.state === "pending") matched.state = "in_progress";
        mappedTurnKeys.add(turnKey);
        fallbackMappedTurns++;
        intentUpdateTimes.push(turn.timestamp.getTime());
        continue;
      }

      unplannedTurns++;
      intentUpdateTimes.push(turn.timestamp.getTime());
      const subject = turn.commitMessage ? `Commit: ${turn.commitMessage}` : (turn.summary || "Unplanned implementation");
      unplanned.push({
        id: `unplanned-${session.session.id}-${turn.index}`,
        subject,
        state: "unplanned",
        ownerLabel: owner?.label ?? null,
        ownerSessionId: session.session.id,
        evidence: {
          edits: turn.filesChanged.length,
          commits: turn.hasCommit ? 1 : 0,
          lastTouchedAt: turn.timestamp,
        },
      });
    }
  }

  unplanned.sort((a, b) => {
    const aTs = a.evidence.lastTouchedAt?.getTime() ?? 0;
    const bTs = b.evidence.lastTouchedAt?.getTime() ?? 0;
    return bTs - aTs;
  });

  const inProgress = plannedTasks.filter(t => t.state === "in_progress" || t.state === "blocked" || t.state === "pending");
  const done = plannedTasks.filter(t => t.state === "completed");

  const plannedTotal = plannedTasks.length;
  const executingCount = plannedTasks.filter(t => t.state === "in_progress" || t.state === "blocked" || t.state === "completed").length;
  const intentCoveragePct = plannedTotal > 0 ? Math.round((executingCount / plannedTotal) * 100) : 0;

  const driftDenominator = plannedTotal + unplannedTurns;
  const driftPct = driftDenominator > 0 ? Math.round((unplannedTurns / driftDenominator) * 100) : 0;

  const evidenceRatio = plannedTotal > 0
    ? plannedTasks.filter(hasEvidence).length / plannedTotal
    : 0;
  let intentConfidence: "high" | "medium" | "low";
  if (plannedTotal === 0) {
    intentConfidence = unplannedTurns > 0 ? "low" : "medium";
  } else if (evidenceRatio >= 0.67) {
    intentConfidence = "high";
  } else if (evidenceRatio >= 0.34) {
    intentConfidence = "medium";
  } else {
    intentConfidence = "low";
  }

  const blockedCount = plannedTasks.filter(t => t.state === "blocked").length;
  let intentStatus: IntentInsights["intentStatus"];
  if (plannedTotal === 0) intentStatus = "no_clear_intent";
  else if (blockedCount > 0) intentStatus = "blocked";
  else if (driftPct >= 30 || unplannedTurns >= 2) intentStatus = "drifting";
  else intentStatus = "on_plan";

  if (unplannedTurns > 0) {
    driftReasons.push(`${unplannedTurns} unplanned implementation turn${unplannedTurns !== 1 ? "s" : ""}`);
  }
  if (fallbackMappedTurns > 0) {
    driftReasons.push(`${fallbackMappedTurns} turn${fallbackMappedTurns !== 1 ? "s" : ""} matched to plan by subject`);
  }
  const untouchedPlanned = plannedTasks.filter(t => t.state === "pending" && !hasEvidence(t)).length;
  if (untouchedPlanned > 0 && unplannedTurns > 0) {
    driftReasons.push(`${untouchedPlanned} planned task${untouchedPlanned !== 1 ? "s" : ""} untouched while other work continued`);
  }
  if (blockedCount > 0) {
    driftReasons.push(`${blockedCount} task${blockedCount !== 1 ? "s" : ""} blocked by active collisions`);
  }

  const lastIntentUpdateAt = intentUpdateTimes.length > 0
    ? new Date(Math.max(...intentUpdateTimes))
    : null;

  return {
    intentCoveragePct,
    driftPct,
    intentConfidence,
    intentStatus,
    lastIntentUpdateAt,
    intentLanes: {
      inProgress,
      done,
      unplanned,
    },
    driftReasons,
  };
}

// ─── Dashboard builder ──────────────────────────────────────────────────────

/** Grace period: keep recently-dead sessions visible so feed/plans persist across context clears */
const RECENT_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours
/** How far back to scan for historical plans (beyond RECENT_GRACE_MS) */
const PLAN_HISTORY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function buildDashboardState(prefetchedActiveSessions?: SessionInfo[]): DashboardState {
  return buildDashboardSnapshot(prefetchedActiveSessions).state;
}

export interface DashboardSnapshot {
  state: DashboardState;
  parsedSessions: ParsedSession[];
}

export function buildDashboardSnapshot(prefetchedActiveSessions?: SessionInfo[]): DashboardSnapshot {
  // 0. Load operator config
  const config = loadOperatorConfig();
  const selfName = getSelfName(config);

  // Build operator registry
  const operatorRegistry: Operator[] = [
    { id: "self", name: selfName, color: getOperatorColor(0), status: "offline" },
  ];
  for (let i = 0; i < config.operators.length; i++) {
    const op = config.operators[i];
    operatorRegistry.push({
      id: makeOperatorId(op.name),
      name: op.name,
      color: getOperatorColor(i + 1),
      status: "offline",
    });
  }

  // Session → operator mapping
  const sessionOperatorMap = new Map<string, string>();

  // 1. Get all active sessions (self) — use prefetched if available to avoid redundant pgrep/lsof
  const activeSessions = prefetchedActiveSessions ?? getActiveSessions();
  const activeSessionIds = new Set(activeSessions.map(s => s.id));

  // Tag self sessions
  for (const s of activeSessions) {
    sessionOperatorMap.set(s.id, "self");
  }

  // 2. Include active sessions + recently-dead sessions from same projects
  const allSessions = new Map<string, SessionInfo>();
  for (const s of activeSessions) {
    allSessions.set(s.id, s);
  }

  const projects = listProjects();
  const now = Date.now();

  // For each project, include recent inactive sessions
  for (const project of projects) {
    const projectSessions = listSessions(project.encodedName);
    for (const s of projectSessions) {
      if (allSessions.has(s.id)) continue;
      if (now - s.modifiedAt.getTime() < RECENT_GRACE_MS) {
        allSessions.set(s.id, s);
        if (!sessionOperatorMap.has(s.id)) sessionOperatorMap.set(s.id, "self");
      }
    }
  }

  // Codex discovery (self) — fully isolated
  try {
    const codexActiveSessions = getActiveCodexSessions();
    const codexRecent = discoverCodexSessions(1);
    for (const s of [...codexActiveSessions, ...codexRecent]) {
      if (allSessions.has(s.id)) continue;
      allSessions.set(s.id, s);
      if (!sessionOperatorMap.has(s.id)) sessionOperatorMap.set(s.id, "self");
    }
    for (const s of codexActiveSessions) activeSessionIds.add(s.id);
  } catch { /* Codex failure — continue Claude-only */ }

  // 2b. Discover sessions from configured operators
  for (const op of config.operators) {
    const opId = makeOperatorId(op.name);
    try {
      // Claude sessions for this operator
      if (op.claude) {
        const opProjects = listProjects(op.claude);
        for (const project of opProjects) {
          const opSessions = listSessions(project.encodedName, op.claude);
          for (const s of opSessions) {
            if (allSessions.has(s.id)) continue;
            if (now - s.modifiedAt.getTime() < RECENT_GRACE_MS) {
              allSessions.set(s.id, s);
              sessionOperatorMap.set(s.id, opId);
            }
          }
        }
      }
      // Codex sessions for this operator
      if (op.codex) {
        const opCodexSessions = discoverCodexSessions(1, op.codex);
        for (const s of opCodexSessions) {
          if (allSessions.has(s.id)) continue;
          allSessions.set(s.id, s);
          sessionOperatorMap.set(s.id, opId);
        }
      }
    } catch { /* skip broken operator config */ }
  }

  // 2c. Collect historical sessions for plan history (beyond RECENT_GRACE_MS, up to PLAN_HISTORY_MS)
  const historicalSessions = new Map<string, SessionInfo>();
  for (const project of projects) {
    for (const s of listSessions(project.encodedName)) {
      if (allSessions.has(s.id) || historicalSessions.has(s.id)) continue;
      if (isCodexSession(s)) continue;
      const age = now - s.modifiedAt.getTime();
      if (age >= RECENT_GRACE_MS && age < PLAN_HISTORY_MS) {
        historicalSessions.set(s.id, s);
      }
    }
  }
  for (const op of config.operators) {
    if (!op.claude) continue;
    try {
      for (const project of listProjects(op.claude)) {
        for (const s of listSessions(project.encodedName, op.claude)) {
          if (allSessions.has(s.id) || historicalSessions.has(s.id)) continue;
          if (isCodexSession(s)) continue;
          const age = now - s.modifiedAt.getTime();
          if (age >= RECENT_GRACE_MS && age < PLAN_HISTORY_MS) {
            historicalSessions.set(s.id, s);
          }
        }
      }
    } catch { /* skip */ }
  }

  // 3. Parse all sessions
  const parsedSessions: ParsedSession[] = [];
  const sessionLastActivityMs = new Map<string, number>();
  const claudeParsedIds = new Set<string>();
  const codexSessionIds = new Set<string>();
  for (const session of allSessions.values()) {
    if (isCodexSession(session)) continue;
    try {
      parsedSessions.push(getCachedOrParse(session));
      sessionLastActivityMs.set(session.id, session.modifiedAt.getTime());
      claudeParsedIds.add(session.id);
    } catch {
      // Skip unparseable sessions
    }
  }

  // Parse Codex sessions
  for (const session of allSessions.values()) {
    if (claudeParsedIds.has(session.id)) continue;
    if (!isCodexSession(session)) continue;
    try {
      parsedSessions.push(getCachedOrParseCodex(session));
      sessionLastActivityMs.set(session.id, session.modifiedAt.getTime());
      codexSessionIds.add(session.id);
    } catch { /* skip broken Codex session */ }
  }

  // 4. Build session label map (include historical session IDs for plan labels)
  const labelMap = buildLabelMap([
    ...parsedSessions.map(p => p.session.id),
    ...[...historicalSessions.keys()],
  ]);

  const collisionSessionIds = new Set<string>();

  const sessionPlansMap = new Map<string, SessionPlan[]>();
  for (const parsed of parsedSessions) {
    const label = labelMap.get(parsed.session.id) ?? parsed.session.id.slice(0, 8);
    const isActive = activeSessionIds.has(parsed.session.id);
    sessionPlansMap.set(parsed.session.id, buildCanonicalSessionPlans(parsed, label, isActive));
  }

  // 5b. Cache uncommitted files per project
  const uncommittedByProject = new Map<string, string[]>();
  function cachedUncommitted(projectPath: string): string[] {
    if (!uncommittedByProject.has(projectPath)) {
      uncommittedByProject.set(projectPath, getUncommittedFiles(projectPath));
    }
    return uncommittedByProject.get(projectPath)!;
  }

  // 6. Build agents
  const agents: Agent[] = [];

  for (const parsed of parsedSessions) {
    const projectPath = parsed.session.projectPath;
    const label = labelMap.get(parsed.session.id) ?? parsed.session.id.slice(0, 8);
    const isActive = activeSessionIds.has(parsed.session.id);
    const isCodexAgent = codexSessionIds.has(parsed.session.id);
    const status = determineAgentStatus(parsed, isActive, collisionSessionIds, isCodexAgent);

    const lastTurn = parsed.turns[parsed.turns.length - 1];
    const currentTask = lastTurn?.summary ?? "idle";

    const plans = sessionPlansMap.get(parsed.session.id) ?? [];

    // Risk: pass accumulated error history for trend continuity, and accumulated cost for compaction
    const sessionAcc = accumulators.get(parsed.session.id);
    const risk = computeAgentRisk(parsed, sessionAcc?.errorHistory, sessionAcc?.totalCost);

    const blockedOn = status === "blocked"
      ? getBlockedForSession(parsed.session.id).map((info) => {
          const detail = extractToolDetail(info.toolName, info.toolInput);
          return { requestId: info.requestId, toolName: info.toolName, description: describeBlockedTool(info), ...(detail ? { detail } : {}) };
        })
      : undefined;

    agents.push({
      sessionId: parsed.session.id,
      label,
      agentType: isCodexAgent ? "codex" : "claude",
      status,
      currentTask,
      filesChanged: parsed.stats.filesChanged,
      uncommittedFiles: cachedUncommitted(projectPath),
      projectPath,
      isActive,
      plans,
      risk,
      operatorId: sessionOperatorMap.get(parsed.session.id) ?? "self",
      blockedOn,
    });
  }

  // 6b. Build plan history from older sessions (plans only, no agents)
  const historicalPlansMap = new Map<string, SessionPlan[]>();
  for (const session of historicalSessions.values()) {
    try {
      const parsed = getCachedOrParse(session);
      const label = labelMap.get(session.id) ?? session.id.slice(0, 8);
      const plans = buildCanonicalSessionPlans(parsed, label, false);
      if (plans.length === 0) continue;
      const pp = parsed.session.projectPath;
      if (!historicalPlansMap.has(pp)) historicalPlansMap.set(pp, []);
      historicalPlansMap.get(pp)!.push(...plans);
    } catch { /* skip unparseable */ }
  }

  // ─── Stall / idle detection (post-pass, no existing code modified) ──
  const STALL_WARN_MS = 15 * 60 * 1000;  // 15 min → elevated
  const STALL_CRIT_MS = 45 * 60 * 1000;  // 45 min → critical
  const IDLE_MS = 5 * 60 * 1000;         // 5 min with no active work → idle

  /** Sessions that are stalled (have active work but went silent) */
  const stalledSessionIds = new Set<string>();

  for (const agent of agents) {
    if (!agent.isActive) continue;
    const session = allSessions.get(agent.sessionId);
    if (!session) continue;
    const silenceMs = now - session.modifiedAt.getTime();
    if (silenceMs < IDLE_MS) continue;

    // Determine if this agent has active work (plans being drafted/implemented, or pending/in-progress tasks)
    const hasActiveWork = agent.plans.some(p =>
      p.status === "drafting" || p.status === "implementing"
    ) || agent.plans.some(p =>
      p.tasks.some(t => t.status === "in_progress" || t.status === "pending")
    );

    if (hasActiveWork && silenceMs > STALL_WARN_MS) {
      // Stalled: was working towards a goal but went silent
      stalledSessionIds.add(agent.sessionId);
      if (silenceMs > STALL_CRIT_MS) {
        agent.risk.spinningSignals.push({
          pattern: "stalled",
          level: "critical",
          detail: `No activity for ${formatIdleDuration(silenceMs)}`,
        });
      } else {
        agent.risk.spinningSignals.push({
          pattern: "stalled",
          level: "elevated",
          detail: `No activity for ${formatIdleDuration(silenceMs)}`,
        });
      }
      // Recompute overallRisk for stall signals
      if (agent.risk.spinningSignals.some(s => s.level === "critical")) {
        agent.risk.overallRisk = "critical";
      } else if (agent.risk.overallRisk === "nominal" && agent.risk.spinningSignals.some(s => s.level === "elevated")) {
        agent.risk.overallRisk = "elevated";
      }
    } else {
      // Idle: session alive but no active work — soft signal, no risk escalation
      agent.risk.spinningSignals.push({
        pattern: "idle",
        level: "nominal",
        detail: `Idle for ${formatIdleDuration(silenceMs)}`,
      });
    }
  }

  // 7. Build workstreams (group by project)
  const projectGroups = new Map<string, ParsedSession[]>();
  for (const parsed of parsedSessions) {
    const key = parsed.session.projectPath;
    if (!projectGroups.has(key)) projectGroups.set(key, []);
    projectGroups.get(key)!.push(parsed);
  }

  const isRenderablePlan = (p: SessionPlan): boolean => (
    p.status !== "none"
    && p.status !== "rejected"
    && !(p.status === "drafting" && !p.markdown && !p.draftingActivity)
  );

  const workstreams: Workstream[] = [];
  for (const [projectPath, sessions] of projectGroups) {
    const allProjectAgents = agents.filter(a => a.projectPath === projectPath);
    const activeProjectAgents = allProjectAgents.filter(a => a.isActive);
    const hasAgentPlans = allProjectAgents.some(a => a.plans.length > 0);
    const hasHistoricalPlans = historicalPlansMap.has(projectPath);
    if (activeProjectAgents.length === 0 && !hasAgentPlans && !hasHistoricalPlans) continue;
    const orderedActiveProjectAgents = [...activeProjectAgents].sort((a, b) => (
      (sessionLastActivityMs.get(b.sessionId) ?? 0) - (sessionLastActivityMs.get(a.sessionId) ?? 0)
      || a.label.localeCompare(b.label)
      || a.sessionId.localeCompare(b.sessionId)
    ));
    let totalTurns = 0;
    let completedTurns = 0;
    let commits = 0;
    let errors = 0;

    for (const s of sessions) {
      totalTurns += s.turns.length;
      completedTurns += s.turns.filter(t => t.hasCommit).length;
      commits += s.stats.commits;
      errors += s.turns.filter(t => t.hasError).length;
    }

    const hasCollision = orderedActiveProjectAgents.some(a => a.status === "conflict");
    const conflictSessionIds = new Set(
      orderedActiveProjectAgents
        .filter(a => a.status === "conflict")
        .map(a => a.sessionId)
    );

    const agentByLabel = new Map(allProjectAgents.map(a => [a.label, a]));

    // Preserve plan history for the Plans panel/workstream card.
    let plans = allProjectAgents
      .flatMap(a => a.plans)
      .filter((p) => {
        if (!isRenderablePlan(p)) return false;
        const owner = agentByLabel.get(p.agentLabel);
        // Plans panel should only show Claude plans (keep codex plans for intent math below).
        if (owner?.agentType === "codex") return false;
        // Ignore stale drafting plans from inactive sessions (e.g. user esc/cancel then exited).
        if (p.status === "drafting" && owner && !owner.isActive) return false;
        return true;
      });

    // Merge historical plans from older sessions (plan-only, no agents)
    const histPlans = historicalPlansMap.get(projectPath);
    if (histPlans) {
      for (const hp of histPlans) {
        if (isRenderablePlan(hp)) plans.push(hp);
      }
    }
    plans.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Use only active-agent plans for live intent/progress calculations.
    const livePlans = orderedActiveProjectAgents.flatMap(a => a.plans).filter(isRenderablePlan);
    const planTasks = livePlans.flatMap(p => p.tasks);

    let completionPct: number;
    if (planTasks.length > 0) {
      const done = planTasks.filter(t => t.status === "completed").length;
      completionPct = Math.round((done / planTasks.length) * 100);
    } else {
      completionPct = totalTurns > 0 ? Math.round((completedTurns / totalTurns) * 100) : 0;
    }

    const project = projects.find(p => p.decodedPath === projectPath);
    const projectId = project?.encodedName ?? projectPath.replace(/\//g, "-");

    const risk = computeWorkstreamRisk(orderedActiveProjectAgents);
    const intent = buildIntentInsights(sessions, allProjectAgents, livePlans, conflictSessionIds);

    const agentTypes = new Set(allProjectAgents.map(a => a.agentType));
    const mode: WorkstreamMode = agentTypes.has("codex") && agentTypes.has("claude") ? "mixed"
      : agentTypes.has("codex") ? "codex" : "claude";

    let totalCommands = 0;
    let totalPatches = 0;
    for (const s of sessions) {
      for (const t of s.turns) {
        totalCommands += t.commands.length;
        totalPatches += t.filesChanged.length;
      }
    }

    workstreams.push({
      projectId,
      projectPath,
      name: basename(projectPath) || projectPath,
      agents: orderedActiveProjectAgents,
      completionPct,
      totalTurns,
      completedTurns,
      hasCollision,
      commits,
      errors,
      plans,
      planTasks,
      risk,
      intentCoveragePct: intent.intentCoveragePct,
      driftPct: intent.driftPct,
      intentConfidence: intent.intentConfidence,
      intentStatus: intent.intentStatus,
      lastIntentUpdateAt: intent.lastIntentUpdateAt,
      intentLanes: intent.intentLanes,
      driftReasons: intent.driftReasons,
      mode,
      totalCommands,
      totalPatches,
    });
  }

  // 7b. Create plan-only workstreams for projects with only historical plans (no recent sessions)
  for (const [projectPath, histPlans] of historicalPlansMap) {
    if (workstreams.some(ws => ws.projectPath === projectPath)) continue;
    const renderablePlans = histPlans.filter(isRenderablePlan);
    if (renderablePlans.length === 0) continue;
    renderablePlans.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const project = projects.find(p => p.decodedPath === projectPath);
    const projectId = project?.encodedName ?? projectPath.replace(/\//g, "-");
    workstreams.push({
      projectId,
      projectPath,
      name: basename(projectPath) || projectPath,
      agents: [],
      completionPct: 0,
      totalTurns: 0,
      completedTurns: 0,
      hasCollision: false,
      commits: 0,
      errors: 0,
      plans: renderablePlans,
      planTasks: renderablePlans.flatMap(p => p.tasks),
      risk: computeWorkstreamRisk([]),
      intentCoveragePct: 0,
      driftPct: 0,
      intentConfidence: "low",
      intentStatus: "no_clear_intent",
      lastIntentUpdateAt: null,
      intentLanes: { inProgress: [], done: [], unplanned: [] },
      driftReasons: [],
      mode: "claude",
      totalCommands: 0,
      totalPatches: 0,
    });
  }

  // Stable sort workstreams by name to avoid visual jumpiness when activity shifts.
  workstreams.sort((a, b) => {
    return a.name.localeCompare(b.name) || a.projectPath.localeCompare(b.projectPath);
  });

  // 8. Build feed
  const feed = buildFeed(parsedSessions, labelMap, activeSessionIds, sessionOperatorMap, stalledSessionIds);

  // 9. Build operators — set status to "online" if any agents are active
  const operatorActiveSet = new Set<string>();
  for (const agent of agents) {
    if (agent.isActive) operatorActiveSet.add(agent.operatorId);
  }
  const operators: Operator[] = operatorRegistry.map(op => ({
    ...op,
    status: operatorActiveSet.has(op.id) ? "online" as const : "offline" as const,
  }));

  // 10. Build summary — only active agents are exposed
  const riskOrder: Record<string, number> = { critical: 0, elevated: 1, nominal: 2 };
  const activeAgents = agents
    .filter(a => a.isActive)
    .sort((a, b) => (
      (riskOrder[a.risk.overallRisk] ?? 2) - (riskOrder[b.risk.overallRisk] ?? 2)
      || a.label.localeCompare(b.label)
      || a.sessionId.localeCompare(b.sessionId)
    ));
  const agentsAtRisk = activeAgents.filter(a => a.risk.overallRisk !== "nominal").length;
  const blockedAgentCount = activeAgents.filter(a => a.status === "blocked").length;
  const totalCost = activeAgents.reduce((sum, a) => sum + a.risk.costPerSession, 0);
  const summary: DashboardSummary = {
    totalAgents: activeAgents.length,
    activeAgents: activeAgents.length,
    totalCollisions: 0,
    criticalCollisions: 0,
    totalWorkstreams: workstreams.length,
    totalCommits: workstreams.reduce((sum, w) => sum + w.commits, 0),
    totalErrors: workstreams.reduce((sum, w) => sum + w.errors, 0),
    agentsAtRisk,
    blockedAgents: blockedAgentCount,
    operatorCount: operators.length,
    totalCost,
  };

  const localPlanCollisions: DashboardState["localPlanCollisions"] = [];

  // ─── Cache GC: evict entries for sessions no longer in the working set ───
  // Without this, parseCache/codexParseCache/accumulators grow unbounded as
  // sessions age past the discovery window (24h recent + 7d historical).
  const liveSessionIds = new Set<string>([
    ...allSessions.keys(),
    ...historicalSessions.keys(),
  ]);
  for (const id of parseCache.keys()) {
    if (!liveSessionIds.has(id)) parseCache.delete(id);
  }
  for (const id of codexParseCache.keys()) {
    if (!liveSessionIds.has(id)) codexParseCache.delete(id);
  }
  for (const id of accumulators.keys()) {
    if (!liveSessionIds.has(id)) accumulators.delete(id);
  }

  return {
    state: { operators, agents: activeAgents, workstreams, collisions: [], localPlanCollisions, feed, summary },
    parsedSessions,
  };
}

/** How long since last file modification before an active session is considered idle */
const IDLE_THRESHOLD_MS = 120_000; // 2 minutes (fallback — Stop hook handles the normal case for Claude)

function determineAgentStatus(
  parsed: ParsedSession,
  isActive: boolean,
  collisionSessionIds: Set<string>,
  isCodex = false,
): AgentStatus {
  // Blocked: waiting on user permission approval (from CC hook)
  if (hasBlockedSession(parsed.session.id)) return "blocked";

  // Conflict: this session has files in a detected collision
  if (collisionSessionIds.has(parsed.session.id)) return "conflict";

  // Warning: 2+ of the last 3 turns have errors (single errors are normal self-correction)
  const recentTurns = parsed.turns.slice(-3);
  const recentErrorCount = recentTurns.filter(t => t.hasError).length;
  if (recentErrorCount >= 2) return "warning";

  // Active process — determine busy vs idle
  if (isActive) {
    const mtimeMs = parsed.session.modifiedAt.getTime();

    // Instant idle: last turn was interrupted (Stop hook doesn't fire on interrupt)
    const lastTurn = parsed.turns[parsed.turns.length - 1];
    if (lastTurn?.category === "interruption") return "idle";

    // Instant idle: Stop hook fired and transcript hasn't changed since (Claude only)
    if (!isCodex && isSessionStopped(parsed.session.id, mtimeMs)) return "idle";

    // Codex has no Stop hook — use Codex event semantics for responsiveness.
    if (isCodex) {
      return resolveCodexBusyIdle({
        nowMs: Date.now(),
        sessionMtimeMs: mtimeMs,
        processAlive: isActive,
        runtime: parsed.codexRuntime,
        lastTurn,
      });
    }

    // Claude fallback: no recent file writes → idle
    return Date.now() - mtimeMs > IDLE_THRESHOLD_MS ? "idle" : "busy";
  }

  return "idle";
}

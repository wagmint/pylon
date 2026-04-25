import { listProjects, listSessions } from "../providers/claude/discovery.js";
import { toProviderSessionRef } from "../providers/types.js";
import type { ProviderSessionRef } from "../providers/types.js";
import { codexAdapter } from "../providers/codex/adapter.js";
import { pendingDecisions } from "../core/blocked.js";
import { withTransaction } from "./db.js";
import {
  ensureIngestionCheckpoint,
  markMissingTranscriptSourcesInactive,
  upsertSession,
  upsertTranscriptSource,
} from "./repositories.js";
import { ingestTranscriptSource } from "./sync.js";
import { deriveAndStoreSessionState } from "./session-state.js";
import { deriveAndStoreTasksForSession } from "./tasks.js";
import { deriveAndStoreWorkstreamsForProject } from "./workstreams.js";
import { deriveAndStoreM6ForProject } from "./m6.js";
import { deriveAndStoreHandoffsForProject } from "./handoffs.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type BackfillPriority = 1 | 2 | 3 | 4;
type BackfillPhase = "idle" | "running" | "complete";

export interface BackfillProgress {
  phase: BackfillPhase;
  totalDiscovered: number;
  ingested: number;
  skipped: number;
  errors: number;
  currentSessionId: string | null;
  currentPriority: BackfillPriority | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface QueueEntry {
  ref: ProviderSessionRef;
  priority: BackfillPriority;
}

// ─── Priority thresholds ─────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;

function assignPriority(ref: ProviderSessionRef, now: number): BackfillPriority {
  // P1: session has a pending hook decision
  for (const pending of pendingDecisions.values()) {
    if (pending.sessionId === ref.id) return 1;
  }

  const ageMs = now - ref.sourceMtime.getTime();
  if (ageMs < ONE_HOUR_MS) return 2;
  if (ageMs < TWENTY_FOUR_HOURS_MS) return 3;
  return 4;
}

// ─── BackfillQueue ───────────────────────────────────────────────────────────

export class BackfillQueue {
  private queue: QueueEntry[] = [];
  private aborted = false;
  private progress: BackfillProgress = {
    phase: "idle",
    totalDiscovered: 0,
    ingested: 0,
    skipped: 0,
    errors: 0,
    currentSessionId: null,
    currentPriority: null,
    startedAt: null,
    completedAt: null,
  };
  private seenSessionIds: string[] = [];
  private seenProjectPaths = new Set<string>();
  private discoveredProviders = new Set<string>();

  async start(): Promise<void> {
    this.progress.phase = "running";
    this.progress.startedAt = Date.now();

    // Discover all Claude sessions
    const now = Date.now();
    const projects = listProjects();
    this.discoveredProviders.add("claude");
    for (const project of projects) {
      for (const session of listSessions(project.encodedName)) {
        const ref = toProviderSessionRef("claude", session);
        this.queue.push({ ref, priority: assignPriority(ref, now) });
      }
    }

    // Discover Codex sessions
    try {
      const codexSessions = await codexAdapter.discoverSessions();
      this.discoveredProviders.add("codex");
      for (const ref of codexSessions) {
        this.queue.push({ ref, priority: assignPriority(ref, now) });
      }
    } catch (err) {
      console.error("[backfill] codex discovery failed:", err);
    }

    this.progress.totalDiscovered = this.queue.length;

    // Sort: lower priority number first, then by mtime descending within each priority
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.ref.sourceMtime.getTime() - a.ref.sourceMtime.getTime();
    });

    await this.processQueue();

    if (!this.aborted) {
      this.runDerivedPasses();
    }

    this.progress.phase = "complete";
    this.progress.completedAt = Date.now();
    this.progress.currentSessionId = null;
    this.progress.currentPriority = null;
  }

  private async processQueue(): Promise<void> {
    for (const entry of this.queue) {
      if (this.aborted) break;

      this.progress.currentSessionId = entry.ref.id;
      this.progress.currentPriority = entry.priority;

      try {
        const didIngest = this.ingestOne(entry);
        if (didIngest) {
          this.progress.ingested++;
        } else {
          this.progress.skipped++;
        }
      } catch (err) {
        this.progress.errors++;
        console.error(`[backfill] error ingesting session ${entry.ref.id}:`, err);
      }

      // Yield to event loop between sessions so HTTP requests get served
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private ingestOne(entry: QueueEntry): boolean {
    const { ref } = entry;

    // Each session gets its own small transaction for crash recovery + memory release
    withTransaction(() => {
      const transcriptSourceId = upsertTranscriptSource(ref);
      ensureIngestionCheckpoint(transcriptSourceId);
      upsertSession(ref, transcriptSourceId);

      // ingestTranscriptSource short-circuits via checkpoint if file unchanged
      ingestTranscriptSource(ref, transcriptSourceId);

      if (ref.provider === "claude") {
        deriveAndStoreSessionState(ref.id);
        deriveAndStoreTasksForSession(ref.id);
      }

      this.seenSessionIds.push(ref.id);
      this.seenProjectPaths.add(ref.projectPath);
    });

    return true;
  }

  private runDerivedPasses(): void {
    try {
      withTransaction(() => {
        // Pass 2: cross-session task derivation
        for (const sessionId of this.seenSessionIds) {
          if (this.aborted) return;
          deriveAndStoreTasksForSession(sessionId);
        }
      });
    } catch (err) {
      console.error("[backfill] pass 2 (cross-session tasks) failed:", err);
    }

    try {
      withTransaction(() => {
        // Pass 3: per-project workstream/m6/handoff derivation
        for (const projectPath of this.seenProjectPaths) {
          if (this.aborted) return;
          deriveAndStoreWorkstreamsForProject(projectPath);
          deriveAndStoreM6ForProject(projectPath);
          deriveAndStoreHandoffsForProject(projectPath);
        }
      });
    } catch (err) {
      console.error("[backfill] pass 3 (project derivation) failed:", err);
    }

    try {
      withTransaction(() => {
        // Mark sources we didn't see as inactive — call for every provider
        // that was successfully discovered (even if 0 sessions were found,
        // so stale sources get deactivated).
        const providerBySessionId = new Map<string, string>();
        for (const entry of this.queue) {
          providerBySessionId.set(entry.ref.id, entry.ref.provider);
        }
        if (this.discoveredProviders.has("claude")) {
          const claudeIds = this.seenSessionIds.filter(
            (id) => providerBySessionId.get(id) === "claude",
          );
          markMissingTranscriptSourcesInactive("claude", claudeIds);
        }
        if (this.discoveredProviders.has("codex")) {
          const codexIds = this.seenSessionIds.filter(
            (id) => providerBySessionId.get(id) === "codex",
          );
          markMissingTranscriptSourcesInactive("codex", codexIds);
        }
      });
    } catch (err) {
      console.error("[backfill] markMissingTranscriptSourcesInactive failed:", err);
    }
  }

  promote(sessionId: string): void {
    const idx = this.queue.findIndex(
      (e) => e.ref.id === sessionId && e.priority !== 1,
    );
    if (idx === -1) return;

    this.queue[idx].priority = 1;

    // Move to front of remaining unprocessed entries
    const currentIdx = this.progress.ingested + this.progress.skipped + this.progress.errors;
    if (idx > currentIdx) {
      const [entry] = this.queue.splice(idx, 1);
      // Insert right after the current processing position
      this.queue.splice(currentIdx, 0, entry);
    }
  }

  isComplete(): boolean {
    return this.progress.phase === "complete";
  }

  getProgress(): BackfillProgress {
    return { ...this.progress };
  }

  abort(): void {
    this.aborted = true;
  }
}

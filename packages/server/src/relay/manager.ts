import type { DashboardState, ParsedSession } from "../types/index.js";
import { loadOperatorConfig, getSelfName, getOperatorColor } from "../core/config.js";
import { loadRelayConfig, saveRelayConfig } from "./config.js";
import { transformToOperatorState } from "./transform.js";
import { buildIntentEventsForTarget } from "./intent-events.js";
import type { NormalizedIntentEvent } from "./intent-events.js";
import { sendIntentEvents, IntentIngestError } from "./intent-api.js";
import { syncHexdeckToRelayTarget } from "./hexdeck-sync.js";
import { pollGitState } from "../core/git-state.js";
import { RelayConnection } from "./connection.js";
import type { RelayConnectionStatus, RelayCollisionAlert, OnCollisionAlerts } from "./connection.js";
import type { RelayTarget, SuggestionPayload, SuggestionResponseMessage, SurfacedWorkstream, SurfacedUnassigned } from "./types.js";
import { suggestionStore } from "./suggestion-store.js";
import { surfacingStore } from "./surfacing-store.js";
import { statusResultStore } from "./status-result-store.js";

const INTENT_BATCH_SIZE = 100;
const INTENT_FLUSH_INTERVAL_MS = 2_000;
const SEEN_EVENT_TTL_MS = 15 * 60 * 1000;
const HEXDECK_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const GIT_STATE_POLL_INTERVAL_MS = 3_000;
const INTENT_BACKOFF_INITIAL_MS = 4_000;
const INTENT_BACKOFF_MAX_MS = 5 * 60 * 1000; // 5 minutes

export interface RelayTargetStatus {
  hexcoreId: string;
  hexcoreName: string;
  status: RelayConnectionStatus;
  projects: string[];
  addedAt: string;
}

interface PendingIntentFlushState {
  queue: NormalizedIntentEvent[];
  queuedIds: Set<string>;
  seenIds: Map<string, number>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushInFlight: Promise<void> | null;
  /** Current backoff delay in ms; 0 = no backoff. Doubles on each consecutive failure. */
  backoffMs: number;
  /** When the backoff period expires (Date.now() + backoffMs). Flushes are skipped until this time. */
  backoffUntil: number;
  /** True when flush is paused due to auth failure (401/403). Cleared on token refresh. */
  authPaused: boolean;
}

interface PendingHexdeckSyncState {
  lastStartedAt: number;
  lastSucceededAt: number | null;
  syncInFlight: Promise<void> | null;
}

class RelayManager {
  private connections = new Map<string, RelayConnection>();
  private pendingIntentFlushByTarget = new Map<string, PendingIntentFlushState>();
  private pendingHexdeckSyncByTarget = new Map<string, PendingHexdeckSyncState>();
  private started = false;
  private collisionAlertCallback: OnCollisionAlerts | null = null;
  private lastGitStatePollAt = 0;

  /** True if any relay targets are configured (keeps ticker alive). */
  get hasTargets(): boolean {
    const config = loadRelayConfig();
    return config.targets.length > 0;
  }

  /** Load config and open connections to all targets. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.syncConnections();
  }

  /** Close all connections. */
  stop(): void {
    this.started = false;
    for (const conn of this.connections.values()) {
      conn.disconnect();
    }
    this.connections.clear();
    for (const state of this.pendingIntentFlushByTarget.values()) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
      }
    }
    this.pendingIntentFlushByTarget.clear();
    this.pendingHexdeckSyncByTarget.clear();
  }

  /** Get status for all configured targets with live connection info. */
  getStatus(): RelayTargetStatus[] {
    const config = loadRelayConfig();
    return config.targets.map((t) => {
      const conn = this.connections.get(t.hexcoreId);
      return {
        hexcoreId: t.hexcoreId,
        hexcoreName: t.hexcoreName,
        status: conn ? conn.status : "disconnected",
        projects: t.projects,
        addedAt: t.addedAt,
      };
    });
  }

  /** Register a callback for cross-operator collision alerts from relay. */
  onCollisionAlerts(cb: OnCollisionAlerts): void {
    this.collisionAlertCallback = cb;
  }

  /** Forward a collision acknowledgment to the relay for a specific hexcore. */
  acknowledgeCollision(hexcoreId: string, collisionId: string, action: "acknowledged" | "confirmed"): void {
    const conn = this.connections.get(hexcoreId);
    if (conn) {
      conn.sendCollisionAck(collisionId, action);
    }
  }

  /** Send a suggestion response to hexcore. Keeps suggestion locally until hexcore confirms. */
  respondToSuggestion(hexcoreId: string, response: SuggestionResponseMessage): boolean {
    const conn = this.connections.get(hexcoreId);
    if (!conn?.isConnected) return false;
    conn.sendSuggestionResponse(response);
    suggestionStore.markResponded(response.suggestionId);
    return true;
  }

  /** Send a work unit status (Done/Dropped) to hexcore for a workstream. */
  reportWorkUnitStatus(hexcoreId: string, workstreamId: string, status: "done" | "dropped"): boolean {
    const conn = this.connections.get(hexcoreId);
    if (!conn?.isConnected) return false;
    const sent = conn.sendWorkUnitStatus(workstreamId, status);
    if (sent) {
      statusResultStore.track(hexcoreId, workstreamId, status);
    }
    return sent;
  }

  /** Check pending/resolved status for a work unit status request. */
  getWorkUnitStatusResult(hexcoreId: string, workstreamId: string): { pending: boolean; result?: { ok: boolean; reason?: string } } {
    if (statusResultStore.isPending(hexcoreId, workstreamId)) {
      return { pending: true };
    }
    const result = statusResultStore.getResult(hexcoreId, workstreamId);
    if (result) {
      return { pending: false, result: { ok: result.ok!, reason: result.reason } };
    }
    return { pending: false };
  }

  /** Find the hexcoreId for a suggestion from the store. */
  findHexcoreForSuggestion(suggestionId: string): string | null {
    const stored = suggestionStore.getById(suggestionId);
    if (!stored) return null;
    return stored.hexcoreId;
  }

  /** Add or update a relay target from parsed connect link fields. */
  addTarget(fields: { hexcoreId: string; hexcoreName: string; wsUrl: string; token: string; relayClientId: string; relayClientSecret: string }): void {
    const config = loadRelayConfig();
    const existing = config.targets.find((t) => t.hexcoreId === fields.hexcoreId);
    if (existing) {
      existing.token = fields.token;
      existing.relayClientId = fields.relayClientId;
      existing.relayClientSecret = fields.relayClientSecret;
      existing.hexcoreName = fields.hexcoreName;
      existing.wsUrl = fields.wsUrl;
    } else {
      const target: RelayTarget = {
        hexcoreId: fields.hexcoreId,
        hexcoreName: fields.hexcoreName,
        wsUrl: fields.wsUrl,
        token: fields.token,
        relayClientId: fields.relayClientId,
        relayClientSecret: fields.relayClientSecret,
        projects: [],
        addedAt: new Date().toISOString(),
      };
      config.targets.push(target);
    }
    saveRelayConfig(config);
    if (this.started) {
      const conn = this.connections.get(fields.hexcoreId);
      if (conn) {
        conn.updateToken(fields.token);
        conn.updateRelayClient(fields.relayClientId, fields.relayClientSecret);
        conn.connect();
      }
      this.syncConnections();
    }
  }

  /** Remove a relay target and disconnect. */
  removeTarget(hexcoreId: string): boolean {
    const config = loadRelayConfig();
    const idx = config.targets.findIndex((t) => t.hexcoreId === hexcoreId);
    if (idx === -1) return false;
    config.targets.splice(idx, 1);
    saveRelayConfig(config);
    const conn = this.connections.get(hexcoreId);
    if (conn) {
      conn.disconnect();
      this.connections.delete(hexcoreId);
    }
    const pending = this.pendingIntentFlushByTarget.get(hexcoreId);
    if (pending?.flushTimer) {
      clearTimeout(pending.flushTimer);
    }
    this.pendingIntentFlushByTarget.delete(hexcoreId);
    this.pendingHexdeckSyncByTarget.delete(hexcoreId);
    return true;
  }

  /** Add a project to a relay target. */
  includeProject(hexcoreId: string, projectPath: string): boolean {
    const config = loadRelayConfig();
    const target = config.targets.find((t) => t.hexcoreId === hexcoreId);
    if (!target) return false;
    if (target.projects.includes(projectPath)) return true;
    target.projects.push(projectPath);
    saveRelayConfig(config);
    return true;
  }

  /** Remove a project from a relay target. */
  excludeProject(hexcoreId: string, projectPath: string): boolean {
    const config = loadRelayConfig();
    const target = config.targets.find((t) => t.hexcoreId === hexcoreId);
    if (!target) return false;
    const idx = target.projects.indexOf(projectPath);
    if (idx === -1) return true;
    target.projects.splice(idx, 1);
    saveRelayConfig(config);
    return true;
  }

  /**
   * Called by the ticker on each interval.
   * Re-reads config (mtime-cached), syncs connections, transforms & sends state.
   */
  onStateUpdate(rawState: DashboardState, parsedSessions: ParsedSession[]): void {
    if (!this.started) return;

    // Hot-reload: sync connections with current config
    this.syncConnections();

    const config = loadRelayConfig();
    if (config.targets.length === 0) return;

    // Get operator info for the transform
    const opConfig = loadOperatorConfig();
    const selfName = getSelfName(opConfig);
    const selfColor = getOperatorColor(0);

    // Throttled git state polling (~3s) — poll once, fan out to all targets.
    // Must poll before the target loop to avoid global dedup consuming changes
    // that multiple targets need to see.
    const now = Date.now();
    let gitChanges: import("../core/git-state.js").GitProjectState[] = [];
    if (now - this.lastGitStatePollAt >= GIT_STATE_POLL_INTERVAL_MS) {
      this.lastGitStatePollAt = now;
      try {
        // Collect all unique project paths across targets
        const allProjects = new Set<string>();
        for (const t of config.targets) {
          for (const p of t.projects) allProjects.add(p);
        }
        if (allProjects.size > 0) {
          gitChanges = pollGitState([...allProjects]);
        }
      } catch {
        // Best effort — never interfere with relay state path
      }
    }

    for (const target of config.targets) {
      if (target.projects.length === 0) continue;

      const conn = this.connections.get(target.hexcoreId);
      if (!conn) continue;

      const state = transformToOperatorState(
        rawState,
        selfName,
        selfColor,
        target.projects,
      );
      conn.sendState(state);

      // Best-effort additive event emission for Hexcore intent pipeline.
      // This must never interfere with the existing relay state path.
      void this.sendIntentEventsForTarget(target, rawState, parsedSessions);
      void this.maybeSyncHexdeckToTarget(target);

      // Fan out git state changes filtered to this target's projects
      if (gitChanges.length > 0) {
        const targetProjects = new Set(target.projects);
        const filtered = gitChanges.filter((g) => targetProjects.has(g.projectPath));
        if (filtered.length > 0) {
          conn.sendGitState(filtered);
        }
      }
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /** Store received suggestions and send ack back to hexcore. */
  private handleSuggestions(hexcoreId: string, suggestions: SuggestionPayload[]): void {
    const ids: string[] = [];
    for (const suggestion of suggestions) {
      suggestionStore.upsert(hexcoreId, suggestion);
      ids.push(suggestion.id);
    }

    // Send acknowledgment back
    const conn = this.connections.get(hexcoreId);
    if (conn?.isConnected) {
      conn.sendSuggestionAck(ids);
    }

    console.log(`[relay] Received ${suggestions.length} suggestions from ${hexcoreId}`);
  }

  /** Remove cancelled suggestions from local store. */
  private handleSuggestionsCancelled(hexcoreId: string, suggestionIds: string[]): void {
    suggestionStore.removeMany(suggestionIds);
    console.log(`[relay] ${suggestionIds.length} suggestions cancelled from ${hexcoreId}`);
  }

  /** Resolve a pending work unit status request with the hexcore ack. */
  private handleWorkUnitStatusAck(hexcoreId: string, workstreamId: string, ok: boolean, reason?: string): void {
    statusResultStore.resolve(hexcoreId, workstreamId, ok, reason);
    if (!ok) {
      console.log(`[relay] Work unit status failed for ${workstreamId} in ${hexcoreId}: ${reason ?? "unknown"}`);
    }
  }

  /** Store surfaced workstreams from hexcore. */
  private handleSurfacedWorkstreams(hexcoreId: string, workstreams: SurfacedWorkstream[], unassigned: SurfacedUnassigned[]): void {
    surfacingStore.upsert(hexcoreId, workstreams, unassigned);
    console.log(`[relay] Received surfaced workstreams from ${hexcoreId}: ${workstreams.length} workstreams, ${unassigned.length} unassigned`);
  }

  /** Handle hexcore confirmation of a suggestion response. */
  private handleSuggestionResolved(hexcoreId: string, suggestionId: string, ok: boolean, reason?: string): void {
    if (ok) {
      suggestionStore.remove(suggestionId);
      console.log(`[relay] Suggestion ${suggestionId} resolved successfully`);
    } else {
      suggestionStore.clearResponded(suggestionId);
      console.log(`[relay] Suggestion ${suggestionId} response failed: ${reason ?? 'unknown'}, unlocked for retry`);
    }
  }

  /** Persist a refreshed access token back to relay.json */
  private handleTokenRefreshed(hexcoreId: string, newToken: string): void {
    const config = loadRelayConfig();
    const target = config.targets.find((t) => t.hexcoreId === hexcoreId);
    if (target) {
      target.token = newToken;
      saveRelayConfig(config);
    }
    // Resume intent event flushing now that we have a fresh token
    const intentState = this.pendingIntentFlushByTarget.get(hexcoreId);
    if (intentState?.authPaused) {
      intentState.authPaused = false;
      intentState.backoffMs = 0;
      intentState.backoffUntil = 0;
      console.log(`[relay] token refreshed for ${hexcoreId}, resuming intent flush`);
    }
  }

  private syncConnections(): void {
    const config = loadRelayConfig();
    const targetIds = new Set(config.targets.map((t) => t.hexcoreId));

    // Remove connections for targets no longer in config
    for (const [id, conn] of this.connections) {
      if (!targetIds.has(id)) {
        conn.disconnect();
        this.connections.delete(id);
        const pending = this.pendingIntentFlushByTarget.get(id);
        if (pending?.flushTimer) {
          clearTimeout(pending.flushTimer);
        }
        this.pendingIntentFlushByTarget.delete(id);
        this.pendingHexdeckSyncByTarget.delete(id);
      }
    }

    // Add/update connections for current targets
    for (const target of config.targets) {
      let conn = this.connections.get(target.hexcoreId);
      if (!conn) {
        conn = new RelayConnection(
          target.hexcoreId,
          target.wsUrl,
          target.token,
          target.relayClientId,
          target.relayClientSecret,
          this.handleTokenRefreshed.bind(this),
          this.collisionAlertCallback,
          this.handleSuggestions.bind(this),
          this.handleSuggestionsCancelled.bind(this),
          this.handleSuggestionResolved.bind(this),
          this.handleSurfacedWorkstreams.bind(this),
          this.handleWorkUnitStatusAck.bind(this),
        );
        this.connections.set(target.hexcoreId, conn);
        conn.connect();
      } else {
        // Update tokens in case they changed
        conn.updateToken(target.token);
        conn.updateRelayClient(target.relayClientId, target.relayClientSecret);
      }
    }
  }

  private async sendIntentEventsForTarget(
    target: RelayTarget,
    rawState: DashboardState,
    parsedSessions: ParsedSession[],
  ): Promise<void> {
    try {
      const allEvents = buildIntentEventsForTarget(rawState, parsedSessions, target.projects);
      if (allEvents.length === 0) return;

      const state = this.getPendingIntentState(target.hexcoreId);
      const now = Date.now();
      this.pruneSeenIntentEventIds(state.seenIds, now);

      for (const event of allEvents) {
        if (state.seenIds.has(event.eventId) || state.queuedIds.has(event.eventId)) {
          continue;
        }
        state.queue.push(event);
        state.queuedIds.add(event.eventId);
      }

      if (state.queue.length === 0) {
        return;
      }

      if (state.queue.length >= INTENT_BATCH_SIZE) {
        await this.flushIntentEvents(target, state);
        return;
      }

      if (!state.flushTimer) {
        state.flushTimer = setTimeout(() => {
          state.flushTimer = null;
          void this.flushIntentEvents(target, state);
        }, INTENT_FLUSH_INTERVAL_MS);
      }
    } catch {
      // Best effort only — keep Hexdeck local/relay behavior unchanged if Hexcore ingest fails.
    }
  }

  private getPendingIntentState(hexcoreId: string): PendingIntentFlushState {
    let state = this.pendingIntentFlushByTarget.get(hexcoreId);
    if (!state) {
      state = {
        queue: [],
        queuedIds: new Set<string>(),
        seenIds: new Map<string, number>(),
        flushTimer: null,
        flushInFlight: null,
        backoffMs: 0,
        backoffUntil: 0,
        authPaused: false,
      };
      this.pendingIntentFlushByTarget.set(hexcoreId, state);
    }
    return state;
  }

  private async flushIntentEvents(target: RelayTarget, state: PendingIntentFlushState): Promise<void> {
    if (state.flushInFlight) {
      return state.flushInFlight;
    }
    // Skip flush if auth is paused (waiting for token refresh)
    if (state.authPaused) return;
    // Skip flush if still in backoff window
    if (state.backoffUntil > Date.now()) return;

    state.flushInFlight = this.doFlushIntentEvents(target, state);
    try {
      await state.flushInFlight;
    } finally {
      state.flushInFlight = null;
    }
  }

  private async doFlushIntentEvents(target: RelayTarget, state: PendingIntentFlushState): Promise<void> {
    while (state.queue.length > 0) {
      const batch = state.queue.slice(0, INTENT_BATCH_SIZE);
      try {
        await sendIntentEvents(target, batch);
      } catch (err) {
        const status = err instanceof IntentIngestError ? err.status : 0;

        if (status === 401 || status === 403) {
          // Auth failure — stop retrying until token is refreshed.
          // Queue is preserved so events flush once auth is restored.
          state.authPaused = true;
          console.error(`[relay] intent flush auth failed (${status}) for ${target.hexcoreId}, pausing until token refresh`);
          break;
        }

        // For 429 and other transient errors, apply exponential backoff
        state.backoffMs = state.backoffMs === 0
          ? INTENT_BACKOFF_INITIAL_MS
          : Math.min(state.backoffMs * 2, INTENT_BACKOFF_MAX_MS);
        state.backoffUntil = Date.now() + state.backoffMs;
        console.error(
          `[relay] intent flush failed for ${target.hexcoreId}:`,
          err instanceof Error ? err.message : err,
          `(backoff ${state.backoffMs}ms)`,
        );
        break;
      }

      // Success — reset backoff
      state.backoffMs = 0;
      state.backoffUntil = 0;

      const now = Date.now();
      for (const event of batch) {
        state.queuedIds.delete(event.eventId);
        state.seenIds.set(event.eventId, now);
      }
      state.queue.splice(0, batch.length);
      this.pruneSeenIntentEventIds(state.seenIds, now);
    }
  }

  private pruneSeenIntentEventIds(cache: Map<string, number>, now: number): void {
    for (const [eventId, seenAt] of cache) {
      if (now - seenAt > SEEN_EVENT_TTL_MS) {
        cache.delete(eventId);
      }
    }
  }

  private getPendingHexdeckSyncState(hexcoreId: string): PendingHexdeckSyncState {
    let state = this.pendingHexdeckSyncByTarget.get(hexcoreId);
    if (!state) {
      state = {
        lastStartedAt: 0,
        lastSucceededAt: null,
        syncInFlight: null,
      };
      this.pendingHexdeckSyncByTarget.set(hexcoreId, state);
    }
    return state;
  }

  private async maybeSyncHexdeckToTarget(target: RelayTarget): Promise<void> {
    if (target.projects.length === 0) return;

    const state = this.getPendingHexdeckSyncState(target.hexcoreId);
    if (state.syncInFlight) return;

    const now = Date.now();
    if (now - state.lastStartedAt < HEXDECK_SYNC_INTERVAL_MS) {
      return;
    }

    state.lastStartedAt = now;
    state.syncInFlight = this.doSyncHexdeckToTarget(target, state);
    try {
      await state.syncInFlight;
    } finally {
      state.syncInFlight = null;
    }
  }

  private async doSyncHexdeckToTarget(target: RelayTarget, state: PendingHexdeckSyncState): Promise<void> {
    try {
      await syncHexdeckToRelayTarget(target.hexcoreId);
      state.lastSucceededAt = Date.now();
    } catch (err) {
      console.error(
        `[relay] hexdeck sync failed for ${target.hexcoreId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export const relayManager = new RelayManager();

import type { DashboardState, ParsedSession } from "../types/index.js";
import { loadOperatorConfig, getSelfName, getOperatorColor } from "../core/config.js";
import { loadRelayConfig, saveRelayConfig } from "./config.js";
import { transformToOperatorState } from "./transform.js";
import { buildIntentEventsForTarget } from "./intent-events.js";
import type { NormalizedIntentEvent } from "./intent-events.js";
import { sendIntentEvents } from "./intent-api.js";
import { RelayConnection } from "./connection.js";
import type { RelayConnectionStatus, RelayCollisionAlert, OnCollisionAlerts } from "./connection.js";
import type { RelayTarget } from "./types.js";

const INTENT_BATCH_SIZE = 100;
const INTENT_FLUSH_INTERVAL_MS = 2_000;
const SEEN_EVENT_TTL_MS = 15 * 60 * 1000;

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
}

class RelayManager {
  private connections = new Map<string, RelayConnection>();
  private pendingIntentFlushByTarget = new Map<string, PendingIntentFlushState>();
  private started = false;
  private collisionAlertCallback: OnCollisionAlerts | null = null;

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

  /** Add or update a relay target from parsed connect link fields. */
  addTarget(fields: { hexcoreId: string; hexcoreName: string; wsUrl: string; token: string; refreshToken: string }): void {
    const config = loadRelayConfig();
    const existing = config.targets.find((t) => t.hexcoreId === fields.hexcoreId);
    if (existing) {
      existing.token = fields.token;
      existing.refreshToken = fields.refreshToken;
      existing.hexcoreName = fields.hexcoreName;
      existing.wsUrl = fields.wsUrl;
    } else {
      const target: RelayTarget = {
        hexcoreId: fields.hexcoreId,
        hexcoreName: fields.hexcoreName,
        wsUrl: fields.wsUrl,
        token: fields.token,
        refreshToken: fields.refreshToken,
        projects: [],
        addedAt: new Date().toISOString(),
      };
      config.targets.push(target);
    }
    saveRelayConfig(config);
    if (this.started) this.syncConnections();
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
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /** Persist a refreshed access token back to relay.json */
  private handleTokenRefreshed(hexcoreId: string, newToken: string): void {
    const config = loadRelayConfig();
    const target = config.targets.find((t) => t.hexcoreId === hexcoreId);
    if (target) {
      target.token = newToken;
      saveRelayConfig(config);
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
          target.refreshToken,
          this.handleTokenRefreshed.bind(this),
          this.collisionAlertCallback,
        );
        this.connections.set(target.hexcoreId, conn);
        conn.connect();
      } else {
        // Update tokens in case they changed
        conn.updateToken(target.token);
        conn.updateRefreshToken(target.refreshToken);
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
      };
      this.pendingIntentFlushByTarget.set(hexcoreId, state);
    }
    return state;
  }

  private async flushIntentEvents(target: RelayTarget, state: PendingIntentFlushState): Promise<void> {
    if (state.flushInFlight) {
      return state.flushInFlight;
    }

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
      await sendIntentEvents(target, batch);

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
}

export const relayManager = new RelayManager();

import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { listProjects, listSessions, getActiveSessions } from "../discovery/sessions.js";
import { getActiveCodexSessions } from "../discovery/codex.js";
import { buildDashboardState, buildDashboardSnapshot } from "../core/dashboard.js";
import { toProviderSessionRef } from "../providers/index.js";
import { blockedSessions, clearBlockedSession, clearStaleBlocked, ensureHooks, createPendingDecision, hasPendingDecision, hasBlockedSession, resolveAllDecisions, markSessionStopped, type BlockedInfo } from "../core/blocked.js";
import { relayManager } from "../relay/manager.js";
import { type ParsedConnectLink, parseConnectLink, exchangeConnectLink, createRelayClaim, deriveHttpBaseFromWs } from "../relay/link.js";
import { syncHexdeckToRelayTarget } from "../relay/hexdeck-sync.js";
import { storeClaim, getClaim, removeClaim, cleanupExpiredClaims } from "../relay/claims.js";
import { buildControlState } from "../control/read-model.js";
import { buildAnalyticsState } from "../control/analytics.js";
import { getStorageDiskUsage, getStorageInfo, initStorage, rebuildStorage } from "../storage/db.js";
import { buildHexcoreExportPayload } from "../storage/hexcore-export.js";
import { listIngestionCheckpoints, listStoredClaudeSessions, listTranscriptSources } from "../storage/repositories.js";
import { reconcileOnStartup, reconcileSessionLifecycles } from "../storage/reconciliation.js";
import { materializePendingSummaries } from "../storage/session-summaries.js";
import { getStorageSyncStatus, syncAllSessionsToStorage } from "../storage/sync.js";
import type { DashboardState } from "../types/index.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StartServerOptions {
  port?: number;
  dashboardDir?: string;
}

// ─── Dashboard Helpers ───────────────────────────────────────────────────────

function serializeDate(d: Date): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

function serializeState(state: DashboardState) {
  return {
    ...state,
    collisions: state.collisions.map((col) => ({
      ...col,
      detectedAt: serializeDate(col.detectedAt),
    })),
    localPlanCollisions: state.localPlanCollisions.map((collision) => ({
      ...collision,
      detectedAt: serializeDate(collision.detectedAt),
    })),
    feed: state.feed.map((ev) => ({
      ...ev,
      timestamp: serializeDate(ev.timestamp),
    })),
  };
}

// ─── SSE Client Management ──────────────────────────────────────────────────

interface SSEClient {
  stream: SSEStreamingApi;
}

const clients = new Set<SSEClient>();
let lastPushedJson = "";
let lastBroadcastTime = 0;
let tickerInterval: ReturnType<typeof setInterval> | null = null;
let sseMessageId = 0;
let tickerRunning = false;
let reconciliationInterval: ReturnType<typeof setInterval> | null = null;
let reconciliationRunning = false;

const RECONCILIATION_INTERVAL_MS = 30_000;

function startReconciliationInterval() {
  if (reconciliationInterval) return;
  reconciliationInterval = setInterval(() => {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    void reconcileSessionLifecycles()
      .catch((err) => console.error("[reconciliation] failed:", err))
      .finally(() => {
        reconciliationRunning = false;
      });
  }, RECONCILIATION_INTERVAL_MS);
}

function shouldTickerRun() {
  return clients.size > 0 || relayManager.hasTargets;
}

function startTicker() {
  if (tickerInterval) return;
  tickerInterval = setInterval(() => {
    if (tickerRunning) return;
    tickerRunning = true;
    const activeSessions = getActiveSessions();
    clearStaleBlocked(activeSessions);
    void (async () => {
      try {
        const prefetchedActiveSessions = activeSessions.map((session) => toProviderSessionRef("claude", session));
        const snapshot = await buildDashboardSnapshot(prefetchedActiveSessions);
        const rawState = snapshot.state;

        // Relay (does its own diff check per connection)
        relayManager.onStateUpdate(rawState, snapshot.parsedSessions);

        // SSE (existing logic)
        const data = serializeState(rawState);
        const json = JSON.stringify(data);
        if (json === lastPushedJson) {
          // No state change — send heartbeat every 5s to keep connection alive
          if (Date.now() - lastBroadcastTime >= 5000) {
            lastBroadcastTime = Date.now();
            for (const client of clients) {
              client.stream.writeSSE({ event: "hb", data: "" }).catch(() => {});
            }
          }
          return;
        }
        lastPushedJson = json;
        lastBroadcastTime = Date.now();
        sseMessageId++;
        const id = String(sseMessageId);
        for (const client of clients) {
          client.stream.writeSSE({ data: json, event: "state", id }).catch(() => {
            // Client disconnected — will be cleaned up by onAbort
          });
        }
      } catch (error) {
        console.error("[dashboard] ticker failed:", error);
      } finally {
        tickerRunning = false;
      }
    })();
  }, 1000);
}

function stopTicker() {
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = null;
  }
}

function addClient(client: SSEClient) {
  clients.add(client);
  if (shouldTickerRun()) startTicker();
}

function removeClient(client: SSEClient) {
  clients.delete(client);
  if (!shouldTickerRun()) stopTicker();
}

// ─── App Factory ─────────────────────────────────────────────────────────────

export function createApp(options?: { dashboardDir?: string }): Hono {
  const app = new Hono();

  app.use("/*", cors());

  // ─── API Routes ───────────────────────────────────────────────────────────

  /** List currently active sessions */
  app.get("/api/sessions/active", (c) => {
    const sessions = [...getActiveSessions(), ...getActiveCodexSessions()]
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    return c.json(
      sessions.map((s) => ({
        id: s.id,
        projectPath: s.projectPath,
        createdAt: s.createdAt.toISOString(),
        modifiedAt: s.modifiedAt.toISOString(),
        sizeBytes: s.sizeBytes,
      }))
    );
  });

  /** List all projects with Claude Code sessions */
  app.get("/api/projects", (c) => {
    const projects = listProjects();
    return c.json(
      projects.map((p) => ({
        encodedName: p.encodedName,
        decodedPath: p.decodedPath,
        sessionCount: p.sessionCount,
        lastActive: p.lastActive.toISOString(),
      }))
    );
  });

  /** List sessions for a project */
  app.get("/api/projects/:encodedName/sessions", (c) => {
    const { encodedName } = c.req.param();
    const sessions = listSessions(encodedName);
    return c.json(
      sessions.map((s) => ({
        id: s.id,
        projectPath: s.projectPath,
        createdAt: s.createdAt.toISOString(),
        modifiedAt: s.modifiedAt.toISOString(),
        sizeBytes: s.sizeBytes,
      }))
    );
  });

  // ─── Dashboard Routes ─────────────────────────────────────────────────────

  /** Full dashboard state */
  app.get("/api/dashboard", async (c) => {
    return c.json(serializeState(await buildDashboardState()));
  });

  /** SSE stream — pushes dashboard state on change */
  app.get("/api/dashboard/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const client: SSEClient = { stream };

      // Send current state immediately
      const data = serializeState(await buildDashboardState());
      const json = JSON.stringify(data);
      sseMessageId++;
      await stream.writeSSE({ data: json, event: "state", id: String(sseMessageId) });

      addClient(client);

      // Block until the client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          removeClient(client);
          resolve();
        });
      });
    });
  });

  /** Dashboard feed only */
  app.get("/api/dashboard/feed", async (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const state = await buildDashboardState();
    const feed = state.feed.slice(0, limit);
    return c.json(
      feed.map((ev) => ({
        ...ev,
        timestamp: serializeDate(ev.timestamp),
      }))
    );
  });

  // ─── Hook Endpoints ──────────────────────────────────────────────────────

  /** Receive blocked notification from Claude Code PermissionRequest hook */
  app.post("/api/hooks/blocked", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const sessionId = pickString(body, "session_id", "sessionId")
        ?? deriveSessionIdFromTranscript(pickString(body, "transcript_path", "transcriptPath"));
      if (!sessionId) {
        return c.json({ error: "Missing session_id" }, 400);
      }

      const transcriptPath = pickString(body, "transcript_path", "transcriptPath");
      const toolName = pickString(body, "tool_name", "toolName", "tool")
        ?? pickString(body, "hook_event_name", "hookEventName")
        ?? "unknown";
      const toolInput = pickRecord(body, "tool_input", "toolInput") ?? {};

      // Stop means the agent finished — not blocked on approval, ignore it.
      if (toolName === "Stop") {
        return c.json({ ok: true });
      }

      // Snapshot JSONL file size so we can detect when the user actually
      // responds (file grows) vs. Claude Code's own post-hook writes.
      let snapshotSize = 0;
      if (transcriptPath) {
        try {
          snapshotSize = fs.statSync(transcriptPath).size;
        } catch { /* file not found — fall back to 0 */ }
      }
      const requestId = crypto.randomUUID();
      blockedSessions.set(requestId, {
        requestId,
        sessionId,
        toolName,
        toolInput,
        blockedAt: Date.now(),
        snapshotSize,
      });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
  });

  /** Long-poll permission gate — called by PermissionRequest hook script.
   *  Holds the HTTP connection until the user approves/denies from UI, or timeout.
   *  Each parallel tool call gets its own requestId so multiple can coexist. */
  app.post("/api/hooks/permission-gate", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const sessionId = pickString(body, "session_id", "sessionId")
        ?? deriveSessionIdFromTranscript(pickString(body, "transcript_path", "transcriptPath"));
      if (!sessionId) {
        return c.json({ error: "Missing session_id" }, 400);
      }

      const toolName = pickString(body, "tool_name", "toolName", "tool")
        ?? pickString(body, "hook_event_name", "hookEventName")
        ?? "unknown";

      if (toolName === "Stop") {
        return c.json({ ok: true });
      }

      const toolInput = pickRecord(body, "tool_input", "toolInput") ?? {};
      const transcriptPath = pickString(body, "transcript_path", "transcriptPath");

      let snapshotSize = 0;
      if (transcriptPath) {
        try {
          snapshotSize = fs.statSync(transcriptPath).size;
        } catch { /* fall back to 0 */ }
      }

      // Each parallel hook invocation gets its own requestId
      const { requestId, promise } = createPendingDecision(sessionId);

      blockedSessions.set(requestId, {
        requestId,
        sessionId,
        toolName,
        toolInput,
        blockedAt: Date.now(),
        snapshotSize,
      });

      // Hold connection until UI decision or timeout
      const decision = await promise;

      // Clean up this specific blocked entry (resolveAllDecisions already does this,
      // but handle the timeout/prompt case too)
      blockedSessions.delete(requestId);

      // "prompt" means timeout/fallback — return empty so script outputs nothing
      // and Claude Code falls through to the local permission dialog
      if (decision === "prompt") {
        return c.text("");
      }

      return c.json({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: decision },
        },
      });
    } catch {
      // On any error, return empty — script outputs nothing, local dialog appears
      return c.text("");
    }
  });

  /** Clear blocked state when tool execution proceeds (e.g., terminal-side approval) */
  app.post("/api/hooks/unblocked", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const sessionId = pickString(body, "session_id", "sessionId")
        ?? deriveSessionIdFromTranscript(pickString(body, "transcript_path", "transcriptPath"));
      if (!sessionId) {
        return c.json({ error: "Missing session_id" }, 400);
      }
      if (!hasBlockedSession(sessionId)) {
        return c.json({ ok: true, skipped: "not_blocked" });
      }
      // Ignore stale unblocked callbacks while a permission request is pending.
      if (hasPendingDecision(sessionId)) {
        return c.json({ ok: true, skipped: "pending_decision" });
      }
      clearBlockedSession(sessionId);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
  });

  /** Mark session as idle immediately when Claude Code finishes its turn (Stop hook) */
  app.post("/api/hooks/stopped", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const sessionId = pickString(body, "session_id", "sessionId")
        ?? deriveSessionIdFromTranscript(pickString(body, "transcript_path", "transcriptPath"));
      if (!sessionId) {
        return c.json({ error: "Missing session_id" }, 400);
      }
      markSessionStopped(sessionId);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
  });

  /** UI endpoint to approve/deny ALL pending decisions for a session */
  app.post("/api/sessions/:id/decide", async (c) => {
    try {
      const sessionId = c.req.param("id");
      const body = await c.req.json<{ action?: string }>();
      const action = body.action;
      if (action !== "approve" && action !== "deny") {
        return c.json({ error: "Invalid action — must be 'approve' or 'deny'" }, 400);
      }
      const count = resolveAllDecisions(sessionId, action === "approve" ? "allow" : "deny");
      if (count === 0) {
        return c.json({ error: "No pending decision for this session" }, 404);
      }
      return c.json({ ok: true, resolved: count });
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
  });

  function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
    for (const k of keys) {
      if (typeof obj[k] === "string" && (obj[k] as string).length > 0) {
        return obj[k] as string;
      }
    }
    return null;
  }

  function pickRecord(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
    for (const k of keys) {
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    }
    return null;
  }

  function deriveSessionIdFromTranscript(transcriptPath: string | null): string | null {
    if (!transcriptPath) return null;
    const base = path.basename(transcriptPath);
    if (!base.endsWith(".jsonl")) return null;
    const id = base.slice(0, -".jsonl".length);
    return id.length > 0 ? id : null;
  }

  // ─── Relay API Routes ─────────────────────────────────────────────────────

  /** List relay targets with live connection status */
  app.get("/api/relay/targets", (c) => {
    return c.json(relayManager.getStatus());
  });

  /** Parse connect link and add/update relay target */
  app.post("/api/relay/connect", async (c) => {
    const body = await c.req.json<{ link?: string }>();
    if (!body.link) {
      return c.json({ error: "Missing 'link' field" }, 400);
    }
    try {
      const parsed = parseConnectLink(body.link);

      // Legacy flow: link has c= (connect code) — exchange immediately
      if (parsed.connectCode) {
        const creds = await exchangeConnectLink(parsed);
        relayManager.addTarget(creds);
        if (shouldTickerRun()) startTicker();
        return c.json({ ok: true, hexcoreId: creds.hexcoreId, hexcoreName: creds.hexcoreName });
      }

      // New flow: link has t= (invite token) — create claim for onboarding
      const claim = await createRelayClaim(parsed);
      storeClaim({ ...claim, createdAt: Date.now() });
      return c.json({
        needsOnboarding: true,
        claimId: claim.claimId,
        hexcoreName: claim.hexcoreName,
        hexcoreId: claim.hexcoreId,
        joinUrl: claim.joinUrl,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid connect link";
      return c.json({ error: message }, 400);
    }
  });

  /** Deep link join — accepts params from hexdeck:// URL directly */
  app.post("/api/relay/join", async (c) => {
    const body = await c.req.json<{ inviteToken?: string; hexcoreId?: string; hexcoreName?: string; wsUrl?: string }>();
    if (!body.inviteToken || !body.hexcoreId) {
      return c.json({ error: "Missing inviteToken or hexcoreId" }, 400);
    }

    const wsUrl = body.wsUrl || "wss://relay.hexcore.app/ws";
    const parsed: ParsedConnectLink = {
      hexcoreId: body.hexcoreId,
      hexcoreName: body.hexcoreName || "Unnamed Team",
      wsUrl,
      inviteToken: body.inviteToken,
    };

    try {
      const claim = await createRelayClaim(parsed);
      storeClaim({ ...claim, createdAt: Date.now() });
      return c.json({
        claimId: claim.claimId,
        hexcoreName: claim.hexcoreName,
        hexcoreId: claim.hexcoreId,
        joinUrl: claim.joinUrl,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create claim";
      return c.json({ error: message }, 400);
    }
  });

  /** Remove a relay target */
  app.delete("/api/relay/targets/:hexcoreId", (c) => {
    const { hexcoreId } = c.req.param();
    const removed = relayManager.removeTarget(hexcoreId);
    if (!removed) {
      return c.json({ error: "Target not found" }, 404);
    }
    if (!shouldTickerRun()) stopTicker();
    return c.json({ ok: true });
  });

  /** Include a project in a relay target */
  app.post("/api/relay/targets/:hexcoreId/include", async (c) => {
    const { hexcoreId } = c.req.param();
    const body = await c.req.json<{ projectPath?: string }>();
    if (!body.projectPath) {
      return c.json({ error: "Missing 'projectPath' field" }, 400);
    }
    const ok = relayManager.includeProject(hexcoreId, body.projectPath);
    if (!ok) {
      return c.json({ error: "Target not found" }, 404);
    }
    return c.json({ ok: true });
  });

  /** Exclude a project from a relay target */
  app.post("/api/relay/targets/:hexcoreId/exclude", async (c) => {
    const { hexcoreId } = c.req.param();
    const body = await c.req.json<{ projectPath?: string }>();
    if (!body.projectPath) {
      return c.json({ error: "Missing 'projectPath' field" }, 400);
    }
    const ok = relayManager.excludeProject(hexcoreId, body.projectPath);
    if (!ok) {
      return c.json({ error: "Target not found" }, 404);
    }
    return c.json({ ok: true });
  });

  /** Manually sync structured Hexdeck session evidence to a relay target */
  app.post("/api/relay/targets/:hexcoreId/hexdeck-sync", async (c) => {
    try {
      const { hexcoreId } = c.req.param();
      const result = await syncHexdeckToRelayTarget(hexcoreId);
      return c.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[hexdeck-sync] failed:", error);
      return c.json({ ok: false, error: message }, 400);
    }
  });

  /** Preview the structured Hexdeck export payload for a relay target without posting it */
  app.get("/api/relay/targets/:hexcoreId/hexdeck-sync/preview", async (c) => {
    try {
      const { hexcoreId } = c.req.param();
      const target = relayManager.getStatus().find((entry) => entry.hexcoreId === hexcoreId);
      if (!target) {
        return c.json({ error: "Target not found" }, 404);
      }

      await initStorage();
      const payload = buildHexcoreExportPayload(target.projects);

      const sessionPreview = payload.sessions.slice(0, 5).map((session) => ({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        status: session.status,
        sourceLastEventAt: session.sourceLastEventAt,
        messageCount: session.evidence.messages.length,
        planItemCount: session.evidence.planItems.length,
        commandCount: session.evidence.commands.length,
        fileTouchCount: session.evidence.fileTouches.length,
        approvalCount: session.evidence.approvals.length,
        errorCount: session.evidence.errors.length,
      }));

      return c.json({
        ok: true,
        schemaVersion: payload.schemaVersion,
        checkpoint: payload.checkpoint,
        sessionCount: payload.sessions.length,
        preview: sessionPreview,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[hexdeck-sync-preview] failed:", error);
      return c.json({ ok: false, error: message }, 400);
    }
  });

  /** Poll claim status — used during onboarding flow */
  // Cache completed claims so subsequent polls still return "completed"
  // (the actual claim gets removed after acknowledge, but pollers need to see the result)
  const completedClaims = new Map<string, { hexcoreId: string; hexcoreName: string; completedAt: number }>();

  app.get("/api/relay/claim-status/:claimId", async (c) => {
    const { claimId } = c.req.param();

    // Check completed cache first
    const cached = completedClaims.get(claimId);
    if (cached) {
      // Auto-clean after 60s
      if (Date.now() - cached.completedAt > 60_000) {
        completedClaims.delete(claimId);
      } else {
        return c.json({ status: "completed", hexcoreId: cached.hexcoreId, hexcoreName: cached.hexcoreName });
      }
    }

    const claim = getClaim(claimId);
    if (!claim) {
      return c.json({ error: "Claim not found or expired" }, 404);
    }

    // Poll the relay backend for claim status
    const httpBase = deriveHttpBaseFromWs(claim.wsUrl);
    try {
      const response = await fetch(`${httpBase}/api/relay-claims/${claimId}`, {
        headers: { "X-Claim-Secret": claim.claimSecret },
      });

      if (!response.ok) {
        if (response.status === 404) {
          removeClaim(claimId);
          return c.json({ error: "Claim expired" }, 404);
        }
        return c.json({ status: "pending" });
      }

      const body = await response.json() as {
        success: boolean;
        data?: {
          status: string;
          accessToken?: string;
          relayClientId?: string;
          relayClientSecret?: string;
        };
      };

      if (body.data?.status === "completed" && body.data.accessToken && body.data.relayClientId && body.data.relayClientSecret) {
        // Claim completed — add relay target locally, then acknowledge so Hexcore can
        // clear the one-time delivery secret material from the claim row.
        relayManager.addTarget({
          hexcoreId: claim.hexcoreId,
          hexcoreName: claim.hexcoreName,
          wsUrl: claim.wsUrl,
          token: body.data.accessToken,
          relayClientId: body.data.relayClientId,
          relayClientSecret: body.data.relayClientSecret,
        });

        // Auto-relay all active sessions
        const allSessions = [...getActiveSessions(), ...getActiveCodexSessions()];
        const projectPaths = new Set(allSessions.map(s => s.projectPath));
        for (const projectPath of projectPaths) {
          relayManager.includeProject(claim.hexcoreId, projectPath);
        }

        await fetch(`${httpBase}/api/relay-claims/${claimId}/acknowledge`, {
          method: "POST",
          headers: { "X-Claim-Secret": claim.claimSecret },
        }).catch(() => {});
        completedClaims.set(claimId, { hexcoreId: claim.hexcoreId, hexcoreName: claim.hexcoreName, completedAt: Date.now() });
        removeClaim(claimId);
        if (shouldTickerRun()) startTicker();
        return c.json({ status: "completed", hexcoreId: claim.hexcoreId, hexcoreName: claim.hexcoreName });
      }

      return c.json({ status: "pending" });
    } catch {
      return c.json({ status: "pending" });
    }
  });

  /** Cancel a pending claim */
  app.delete("/api/relay/claims/:claimId", (c) => {
    const { claimId } = c.req.param();
    removeClaim(claimId);
    return c.json({ ok: true });
  });

  /** Look up invite token info from hexcore-relay */
  app.get("/api/relay/invite-info", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: "Missing token parameter" }, 400);
    }

    const wsUrl = c.req.query("wsUrl") || "wss://relay.hexcore.app/ws";
    const httpBase = deriveHttpBaseFromWs(wsUrl);

    try {
      const res = await fetch(`${httpBase}/api/invite-tokens/${encodeURIComponent(token)}/info`);
      if (!res.ok) {
        if (res.status === 404) {
          return c.json({ valid: false, error: "Invalid or expired invite token" }, 404);
        }
        return c.json({ valid: false, error: "Failed to look up invite token" }, 502);
      }
      const body = await res.json() as { success?: boolean; data?: { valid?: boolean; hexcoreId?: string; hexcoreName?: string; memberCount?: number } };
      const info = body.data ?? body;
      return c.json({ valid: true, ...info, wsUrl });
    } catch {
      return c.json({ valid: false, error: "Could not reach relay server" }, 502);
    }
  });

  /** Health check */
  app.get("/api/health", (c) => {
    const storage = getStorageInfo();
    const disk = getStorageDiskUsage();
    return c.json({
      status: "ok",
      storage: {
        dbPath: storage.dbPath,
        initializedAt: storage.initializedAt,
        schemaVersion: storage.schemaVersion,
        diskUsage: disk,
      },
    });
  });

  /** Storage status for UX and maintenance flows */
  app.get("/api/storage/status", (c) => {
    return c.json({
      storage: getStorageInfo(),
      diskUsage: getStorageDiskUsage(),
      sync: getStorageSyncStatus(),
      policy: {
        retention: "retain_all_history_for_now",
        compaction: "deferred",
      },
    });
  });

  /** Baseline storage inspection endpoint for M2 */
  app.get("/api/storage/baseline", (c) => {
    return c.json({
      transcriptSources: listTranscriptSources(),
      ingestionCheckpoints: listIngestionCheckpoints(),
      sessions: listStoredClaudeSessions(),
    });
  });

  /** Read-only control plane inspection endpoint for M8 visibility work */
  app.get("/api/control", (c) => {
    // TODO(M8 Phase B): swap this full read-model rebuild for narrower,
    // cacheable control queries once the route shape stabilizes.
    return c.json(buildControlState());
  });

  /** Pre-aggregated analytics for the control page (File Heatmap / Cost / Activity) */
  app.get("/api/control/analytics", (c) => {
    return c.json(buildAnalyticsState());
  });

  /** Rebuild the local parsed index and baseline storage from source transcripts. */
  app.post("/api/storage/rebuild", async (c) => {
    try {
      await rebuildStorage();
      const sync = await syncAllSessionsToStorage("rebuilding");
      await reconcileOnStartup();
      materializePendingSummaries();
      return c.json({
        ok: true,
        storage: getStorageInfo(),
        diskUsage: getStorageDiskUsage(),
        sync: getStorageSyncStatus(),
        rebuilt: sync,
      });
    } catch (error) {
      return c.json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to rebuild local index",
      }, 500);
    }
  });

  // ─── Static Dashboard Serving ─────────────────────────────────────────────

  const dashboardDir = options?.dashboardDir;

  if (dashboardDir) {
    // Serve static files from the Next.js export directory
    app.use("/*", serveStatic({ root: dashboardDir }));

    // Catch-all fallback — serves index.html
    app.get("*", async (c) => {
      const html = fs.readFileSync(path.join(dashboardDir, "index.html"), "utf-8");
      return c.html(html);
    });
  }

  return app;
}

// ─── Server Starter ──────────────────────────────────────────────────────────

export async function startServer(options?: StartServerOptions): Promise<ServerType> {
  const port = options?.port ?? parseInt(process.env.PORT ?? "7433", 10);
  await initStorage();
  await syncAllSessionsToStorage();
  await reconcileOnStartup();
  materializePendingSummaries();
  const app = createApp({ dashboardDir: options?.dashboardDir });

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Hexdeck running on http://localhost:${info.port}`);
    if (options?.dashboardDir) {
      console.log(`Dashboard: http://localhost:${info.port}`);
    }
  });

  // Auto-install Claude Code hooks for blocked detection
  ensureHooks();

  // Start relay manager (connects to configured relay targets)
  relayManager.start();
  if (relayManager.hasTargets) startTicker();

  startReconciliationInterval();

  return server;
}

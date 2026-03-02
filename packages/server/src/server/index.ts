import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { listProjects, listSessions, getActiveSessions } from "../discovery/sessions.js";
import { buildDashboardState } from "../core/dashboard.js";
import { blockedSessions, clearStaleBlocked, ensureHooks, type BlockedInfo } from "../core/blocked.js";
import { relayManager } from "../relay/manager.js";
import { parseConnectLink, exchangeConnectLink } from "../relay/link.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StartServerOptions {
  port?: number;
  dashboardDir?: string;
}

// ─── Dashboard Helpers ───────────────────────────────────────────────────────

function serializeDate(d: Date): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

function serializeState(state: ReturnType<typeof buildDashboardState>) {
  return {
    ...state,
    collisions: state.collisions.map((col) => ({
      ...col,
      detectedAt: serializeDate(col.detectedAt),
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
let tickerInterval: ReturnType<typeof setInterval> | null = null;
let sseMessageId = 0;

function shouldTickerRun() {
  return clients.size > 0 || relayManager.hasTargets;
}

function startTicker() {
  if (tickerInterval) return;
  tickerInterval = setInterval(() => {
    clearStaleBlocked();
    const rawState = buildDashboardState();

    // Relay (does its own diff check per connection)
    relayManager.onStateUpdate(rawState);

    // SSE (existing logic)
    const data = serializeState(rawState);
    const json = JSON.stringify(data);
    if (json === lastPushedJson) return;
    lastPushedJson = json;
    sseMessageId++;
    const id = String(sseMessageId);
    for (const client of clients) {
      client.stream.writeSSE({ data: json, event: "state", id }).catch(() => {
        // Client disconnected — will be cleaned up by onAbort
      });
    }
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
    const sessions = getActiveSessions();
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
  app.get("/api/dashboard", (c) => {
    return c.json(serializeState(buildDashboardState()));
  });

  /** SSE stream — pushes dashboard state on change */
  app.get("/api/dashboard/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const client: SSEClient = { stream };

      // Send current state immediately
      const data = serializeState(buildDashboardState());
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
  app.get("/api/dashboard/feed", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const state = buildDashboardState();
    const feed = state.feed.slice(0, limit);
    return c.json(
      feed.map((ev) => ({
        ...ev,
        timestamp: serializeDate(ev.timestamp),
      }))
    );
  });

  /** Dashboard collisions only */
  app.get("/api/dashboard/collisions", (c) => {
    const state = buildDashboardState();
    return c.json(
      state.collisions.map((col) => ({
        ...col,
        detectedAt: serializeDate(col.detectedAt),
      }))
    );
  });

  // ─── Hook Endpoints ──────────────────────────────────────────────────────

  /** Receive blocked notification from Claude Code PermissionRequest hook */
  app.post("/api/hooks/blocked", async (c) => {
    try {
      const body = await c.req.json<{
        session_id?: string;
        tool_name?: string;
        tool_input?: Record<string, unknown>;
      }>();
      const sessionId = body.session_id;
      if (!sessionId) {
        return c.json({ error: "Missing session_id" }, 400);
      }
      blockedSessions.set(sessionId, {
        sessionId,
        toolName: body.tool_name ?? "unknown",
        toolInput: body.tool_input ?? {},
        blockedAt: Date.now(),
      });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
  });

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
      const creds = await exchangeConnectLink(parsed);
      relayManager.addTarget(creds);
      if (shouldTickerRun()) startTicker();
      return c.json({ ok: true, hexcoreId: creds.hexcoreId, hexcoreName: creds.hexcoreName });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid connect link";
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

  /** Health check */
  app.get("/api/health", (c) => c.json({ status: "ok" }));

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

export function startServer(options?: StartServerOptions): ServerType {
  const port = options?.port ?? parseInt(process.env.PORT ?? "7433", 10);
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

  return server;
}

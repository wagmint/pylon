import WebSocket from "ws";
import type {
  OperatorState,
  AuthMessage,
  StateUpdateMessage,
  HeartbeatMessage,
  CollisionAckMessage,
  GitStateMessage,
  GitProjectState,
  ServerMessage,
  RelayCollision,
  SuggestionPayload,
  SuggestionAckMessage,
  SuggestionResponseMessage,
  SurfacedWorkstream,
  SurfacedUnassigned,
  WorkUnitStatusMessage,
} from "./types.js";

const HEARTBEAT_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PROACTIVE_REFRESH_MS = 12 * 60 * 1000; // renew access token at 12min (JWT TTL is 15min)

export type RelayConnectionStatus = "connected" | "connecting" | "disconnected" | "auth_expired";

/** Callback to persist refreshed token back to config */
export type OnTokenRefreshed = (hexcoreId: string, newToken: string) => void;

/** Callback when WS auth succeeds — safe to resume HTTP calls */
export type OnAuthOk = (hexcoreId: string) => void;

/** Cross-operator collision alert from relay merged_state */
export interface RelayCollisionAlert {
  id: string;
  filePath: string;
  agents: { sessionId: string; label: string; operatorId: string; lastAction: string }[];
  severity: "warning" | "critical";
  alertLevel?: "yellow" | "red";
  isCrossOperator: boolean;
  detectedAt: string;
}

/** Callback for incoming collision alerts */
export type OnCollisionAlerts = (hexcoreId: string, collisions: RelayCollisionAlert[]) => void;

/** Callback for incoming workstream suggestions */
export type OnSuggestions = (hexcoreId: string, suggestions: SuggestionPayload[]) => void;

/** Callback for cancelled suggestions */
export type OnSuggestionsCancelled = (hexcoreId: string, suggestionIds: string[]) => void;

/** Callback for suggestion resolution confirmations */
export type OnSuggestionResolved = (hexcoreId: string, suggestionId: string, ok: boolean, reason?: string) => void;

/** Callback for surfaced workstreams updates */
export type OnSurfacedWorkstreams = (hexcoreId: string, workstreams: SurfacedWorkstream[], unassigned: SurfacedUnassigned[]) => void;

/** Callback for work unit status ack from hexcore */
export type OnWorkUnitStatusAck = (hexcoreId: string, workstreamId: string, ok: boolean, reason?: string) => void;

export class RelayConnection {
  readonly hexcoreId: string;

  private wsUrl: string;
  private token: string;
  private relayClientId: string;
  private relayClientSecret: string;
  private onTokenRefreshed: OnTokenRefreshed | null;
  private onAuthOk: OnAuthOk | null;
  private onCollisionAlerts: OnCollisionAlerts | null;
  private onSuggestions: OnSuggestions | null;
  private onSuggestionsCancelled: OnSuggestionsCancelled | null;
  private onSuggestionResolved: OnSuggestionResolved | null;
  private onSurfacedWorkstreams: OnSurfacedWorkstreams | null;
  private onWorkUnitStatusAck: OnWorkUnitStatusAck | null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private authenticated = false;
  private operatorId: string | null = null;
  private lastStateJson = "";
  private intentionalClose = false;
  private refreshing = false;
  private authExpired = false;

  constructor(
    hexcoreId: string,
    wsUrl: string,
    token: string,
    relayClientId: string = "",
    relayClientSecret: string = "",
    onTokenRefreshed: OnTokenRefreshed | null = null,
    onAuthOk: OnAuthOk | null = null,
    onCollisionAlerts: OnCollisionAlerts | null = null,
    onSuggestions: OnSuggestions | null = null,
    onSuggestionsCancelled: OnSuggestionsCancelled | null = null,
    onSuggestionResolved: OnSuggestionResolved | null = null,
    onSurfacedWorkstreams: OnSurfacedWorkstreams | null = null,
    onWorkUnitStatusAck: OnWorkUnitStatusAck | null = null,
  ) {
    this.hexcoreId = hexcoreId;
    this.wsUrl = wsUrl;
    this.token = token;
    this.relayClientId = relayClientId;
    this.relayClientSecret = relayClientSecret;
    this.onTokenRefreshed = onTokenRefreshed;
    this.onAuthOk = onAuthOk;
    this.onCollisionAlerts = onCollisionAlerts;
    this.onSuggestions = onSuggestions;
    this.onSuggestionsCancelled = onSuggestionsCancelled;
    this.onSuggestionResolved = onSuggestionResolved;
    this.onSurfacedWorkstreams = onSurfacedWorkstreams;
    this.onWorkUnitStatusAck = onWorkUnitStatusAck;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }

  get status(): RelayConnectionStatus {
    if (this.authExpired) return "auth_expired";
    if (this.intentionalClose) return "disconnected";
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) return "connected";
    return "connecting";
  }

  /** Update token (e.g. after config change). Takes effect on next reconnect. */
  updateToken(token: string): void {
    this.token = token;
  }

  /** Update relay client credentials (e.g. after config change). */
  updateRelayClient(relayClientId: string, relayClientSecret: string): void {
    this.relayClientId = relayClientId;
    this.relayClientSecret = relayClientSecret;
  }

  connect(): void {
    this.intentionalClose = false;
    this.authExpired = false;
    this.doConnect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
  }

  sendState(state: OperatorState): void {
    if (!this.isConnected) return;

    const json = JSON.stringify(state);
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;

    const msg: StateUpdateMessage = { type: "state_update", state };
    this.send(msg);
  }

  sendCollisionAck(collisionId: string, action: "acknowledged" | "confirmed"): void {
    if (!this.isConnected) return;
    const msg: CollisionAckMessage = { type: "collision_ack", collisionId, action };
    this.send(msg);
  }

  sendGitState(projects: GitProjectState[]): void {
    if (!this.isConnected) return;
    const msg: GitStateMessage = { type: "git_state", projects };
    this.send(msg);
  }

  sendSuggestionAck(suggestionIds: string[]): void {
    if (!this.isConnected) return;
    const msg: SuggestionAckMessage = { type: "suggestion_ack", suggestionIds };
    this.send(msg);
  }

  sendSuggestionResponse(response: SuggestionResponseMessage): void {
    if (!this.isConnected) return;
    this.send(response);
  }

  sendWorkUnitStatus(workstreamId: string, status: "done" | "dropped"): boolean {
    if (!this.isConnected) return false;
    const msg: WorkUnitStatusMessage = { type: "work_unit_status", workstreamId, status };
    this.send(msg);
    return true;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private doConnect(): void {
    this.cleanup();
    if (this.intentionalClose || this.authExpired) return;

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      // Send auth
      const authMsg: AuthMessage = {
        type: "auth",
        token: this.token,
        hexcoreId: this.hexcoreId,
      };
      this.send(authMsg);

      // Start heartbeat
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          const hb: HeartbeatMessage = { type: "heartbeat" };
          this.send(hb);
        }
      }, HEARTBEAT_INTERVAL_MS);
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (msg.type === "auth_ok") {
          this.authenticated = true;
          this.operatorId = msg.operatorId;
          this.reconnectAttempt = 0;
          this.scheduleProactiveRefresh();
          if (this.onAuthOk) {
            this.onAuthOk(this.hexcoreId);
          }
        } else if (msg.type === "auth_error") {
          const reason = (msg as { reason?: string; message?: string }).reason
            ?? (msg as { message?: string }).message ?? "unknown";
          console.error(`[relay] Auth failed for ${this.hexcoreId}: ${reason}`);

          // Try refreshing for any auth failure when we have relay client credentials
          if (this.relayClientId && this.relayClientSecret) {
            this.tryTokenRefresh();
          } else {
            this.disconnect();
          }
        } else if (msg.type === "merged_state" && this.onCollisionAlerts) {
          // Extract cross-operator collision alerts with alertLevel
          const state = msg.state as { collisions?: RelayCollisionAlert[] };
          if (state?.collisions) {
            const crossOpCollisions = state.collisions.filter(
              c => c.isCrossOperator && c.alertLevel,
            );
            if (crossOpCollisions.length > 0) {
              this.onCollisionAlerts(this.hexcoreId, crossOpCollisions);
            }
          }
        } else if (msg.type === "workstream_suggestions" && this.onSuggestions) {
          const sugMsg = msg as { suggestions?: SuggestionPayload[] };
          if (sugMsg.suggestions && sugMsg.suggestions.length > 0) {
            this.onSuggestions(this.hexcoreId, sugMsg.suggestions);
          }
        } else if (msg.type === "suggestion_cancelled" && this.onSuggestionsCancelled) {
          const cancelMsg = msg as { suggestionIds?: string[] };
          if (cancelMsg.suggestionIds && cancelMsg.suggestionIds.length > 0) {
            this.onSuggestionsCancelled(this.hexcoreId, cancelMsg.suggestionIds);
          }
        } else if (msg.type === "suggestion_resolved" && this.onSuggestionResolved) {
          const resMsg = msg as { suggestionId?: string; ok?: boolean; reason?: string };
          if (resMsg.suggestionId != null && resMsg.ok != null) {
            this.onSuggestionResolved(this.hexcoreId, resMsg.suggestionId, resMsg.ok, resMsg.reason);
          }
        } else if (msg.type === "surfaced_workstreams" && this.onSurfacedWorkstreams) {
          const surfMsg = msg as { workstreams?: SurfacedWorkstream[]; unassigned?: SurfacedUnassigned[] };
          this.onSurfacedWorkstreams(
            this.hexcoreId,
            surfMsg.workstreams ?? [],
            surfMsg.unassigned ?? [],
          );
        } else if (msg.type === "work_unit_status_ack" && this.onWorkUnitStatusAck) {
          const ackMsg = msg as { workstreamId?: string; ok?: boolean; reason?: string };
          if (ackMsg.workstreamId && ackMsg.ok != null) {
            this.onWorkUnitStatusAck(this.hexcoreId, ackMsg.workstreamId, ackMsg.ok, ackMsg.reason);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on("close", () => {
      this.authenticated = false;
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", () => {
      // Error always followed by close event — reconnect handled there
    });
  }

  private async tryTokenRefresh(): Promise<void> {
    if (this.refreshing || this.intentionalClose) return;
    this.refreshing = true;

    try {
      // Derive HTTP URL from WS URL: ws(s)://host/ws → http(s)://host
      const httpUrl = this.wsUrl
        .replace(/^wss:/, "https:")
        .replace(/^ws:/, "http:")
        .replace(/\/ws\/?$/, "");

      const res = await fetch(`${httpUrl}/api/auth/relay-client-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relayClientId: this.relayClientId,
          relayClientSecret: this.relayClientSecret,
        }),
      });

      if (!res.ok) {
        if (res.status === 401) {
          console.error(`[relay] Relay client expired for ${this.hexcoreId}; re-auth required`);
          this.enterAuthExpiredState();
          return;
        }
        console.error(`[relay] Token refresh failed for ${this.hexcoreId}: ${res.status}`);
        this.scheduleReconnect();
        return;
      }

      const body = await res.json() as { success: boolean; data?: { accessToken: string } };
      if (!body.success || !body.data?.accessToken) {
        console.error(`[relay] Token refresh returned invalid response for ${this.hexcoreId}`);
        this.scheduleReconnect();
        return;
      }

      this.token = body.data.accessToken;

      // Persist the new token back to config
      if (this.onTokenRefreshed) {
        this.onTokenRefreshed(this.hexcoreId, this.token);
      }

      console.log(`[relay] Token refreshed for ${this.hexcoreId}, reconnecting`);
      // Close old socket before scheduling so its close event doesn't race
      this.cleanup();
      this.scheduleReconnect();
    } catch (err) {
      console.error(`[relay] Token refresh error for ${this.hexcoreId}:`, err);
      this.scheduleReconnect();
    } finally {
      this.refreshing = false;
    }
  }

  private scheduleProactiveRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.relayClientId || !this.relayClientSecret) return;

    this.refreshTimer = setTimeout(async () => {
      if (!this.isConnected || this.intentionalClose) return;
      console.log(`[relay] Proactive token refresh for ${this.hexcoreId}`);
      await this.tryTokenRefresh();
    }, PROACTIVE_REFRESH_MS);
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.authExpired) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on("error", () => {}); // Prevent unhandled error crash during close
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch {
        // WebSocket may throw if closed before connection established
      }
      this.ws = null;
    }
    this.authenticated = false;
    this.lastStateJson = "";
  }

  private enterAuthExpiredState(): void {
    this.authExpired = true;
    this.cleanup();
  }
}

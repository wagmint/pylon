import WebSocket from "ws";
import type {
  OperatorState,
  AuthMessage,
  StateUpdateMessage,
  HeartbeatMessage,
  CollisionAckMessage,
  ServerMessage,
  RelayCollision,
} from "./types.js";

const HEARTBEAT_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PROACTIVE_REFRESH_MS = 12 * 60 * 1000; // renew access token at 12min (JWT TTL is 15min)

export type RelayConnectionStatus = "connected" | "connecting" | "disconnected" | "auth_expired";

/** Callback to persist refreshed token back to config */
export type OnTokenRefreshed = (hexcoreId: string, newToken: string) => void;

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

export class RelayConnection {
  readonly hexcoreId: string;

  private wsUrl: string;
  private token: string;
  private relayClientId: string;
  private relayClientSecret: string;
  private onTokenRefreshed: OnTokenRefreshed | null;
  private onCollisionAlerts: OnCollisionAlerts | null;
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
    onCollisionAlerts: OnCollisionAlerts | null = null,
  ) {
    this.hexcoreId = hexcoreId;
    this.wsUrl = wsUrl;
    this.token = token;
    this.relayClientId = relayClientId;
    this.relayClientSecret = relayClientSecret;
    this.onTokenRefreshed = onTokenRefreshed;
    this.onCollisionAlerts = onCollisionAlerts;
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
      this.reconnectAttempt = 0;

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
          this.scheduleProactiveRefresh();
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
      this.reconnectAttempt = 0;
      this.doConnect();
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
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
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

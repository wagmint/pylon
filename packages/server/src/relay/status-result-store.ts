/** Tracks pending and resolved work_unit_status requests awaiting hexcore ack. */

export interface StatusRequest {
  hexcoreId: string;
  workstreamId: string;
  status: "done" | "dropped";
  sentAt: string;
  /** Set when ack arrives */
  resolvedAt?: string;
  ok?: boolean;
  reason?: string;
}

const RESULT_TTL_MS = 60_000; // keep resolved results for 60s

class StatusResultStore {
  private pending = new Map<string, StatusRequest>();
  private resolved = new Map<string, StatusRequest>();

  /** Track a new outgoing status request. Key is "hexcoreId:workstreamId". */
  track(hexcoreId: string, workstreamId: string, status: "done" | "dropped"): void {
    const key = `${hexcoreId}:${workstreamId}`;
    this.pending.set(key, {
      hexcoreId,
      workstreamId,
      status,
      sentAt: new Date().toISOString(),
    });
  }

  /** Resolve a pending request with the hexcore ack. */
  resolve(hexcoreId: string, workstreamId: string, ok: boolean, reason?: string): void {
    const key = `${hexcoreId}:${workstreamId}`;
    const req = this.pending.get(key);
    if (!req) return;

    this.pending.delete(key);
    req.resolvedAt = new Date().toISOString();
    req.ok = ok;
    req.reason = reason;
    this.resolved.set(key, req);

    // Auto-clean after TTL
    setTimeout(() => this.resolved.delete(key), RESULT_TTL_MS);
  }

  /** Check if a request is pending (awaiting ack). */
  isPending(hexcoreId: string, workstreamId: string): boolean {
    return this.pending.has(`${hexcoreId}:${workstreamId}`);
  }

  /** Get a resolved result (if any). */
  getResult(hexcoreId: string, workstreamId: string): StatusRequest | undefined {
    return this.resolved.get(`${hexcoreId}:${workstreamId}`);
  }
}

export const statusResultStore = new StatusResultStore();

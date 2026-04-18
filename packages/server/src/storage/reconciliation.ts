import { statSync } from "node:fs";
import { providerAdapters } from "../providers/index.js";
import type {
  AgentProvider,
  AgentProviderAdapter,
  ProviderSessionRef,
  SessionLifecycle,
} from "../providers/types.js";
import { getDb } from "./db.js";
import { getStoredSessionRef } from "./repositories.js";
import { materializeSessionSummary } from "./session-summaries.js";

interface CandidateSessionRow {
  id: string;
  sourceType: string;
  lastEventAt: string;
  status: string | null;
}

export async function reconcileSessionLifecycles(): Promise<void> {
  const db = getDb();

  const candidates = db
    .prepare(
      `
      SELECT
        id,
        source_type as sourceType,
        last_event_at as lastEventAt,
        status
      FROM sessions
      WHERE COALESCE(status, 'discovered') != 'ended'
      `,
    )
    .all() as CandidateSessionRow[];

  if (candidates.length === 0) return;

  const activeByProvider = new Map<AgentProvider, Set<string>>();
  const skippedProviders = new Set<AgentProvider>();
  for (const adapter of providerAdapters) {
    try {
      const active = await adapter.getActiveSessions();
      activeByProvider.set(adapter.provider, new Set(active.map((ref) => ref.id)));
    } catch (error) {
      // Treating discovery failure as "no active sessions" would wrongly finalize
      // live sessions. Skip this provider for the cycle; next cycle retries.
      console.error(
        `[reconciliation] getActiveSessions failed for ${adapter.provider}, skipping cycle:`,
        error,
      );
      skippedProviders.add(adapter.provider);
    }
  }

  const adapterByProvider = new Map<AgentProvider, AgentProviderAdapter>();
  for (const adapter of providerAdapters) {
    adapterByProvider.set(adapter.provider, adapter);
  }

  for (const row of candidates) {
    try {
      if (row.sourceType !== "claude" && row.sourceType !== "codex") continue;
      const provider = row.sourceType;
      if (skippedProviders.has(provider)) continue;
      const adapter = adapterByProvider.get(provider);
      if (!adapter) continue;

      const isActive = activeByProvider.get(provider)?.has(row.id) ?? false;
      if (isActive) {
        refreshLastEventAt(row);
        continue;
      }

      const storedRef = getStoredSessionRef(row.id);
      if (!storedRef) continue;

      const ref = refreshRefFromDisk(storedRef);

      // When a session is no longer in the active set, storage finalizes it.
      // Adapter lifecycle is consulted for canonical endedAt/endReason hints
      // (e.g. explicit_shutdown, stale), but the default is process_gone so
      // recently-inactive sessions don't wait 24h to be marked ended.
      let lifecycle: SessionLifecycle;
      try {
        const parsed = await adapter.parseSession(ref);
        lifecycle = adapter.inferSessionStatus(ref, parsed.parsed, false);
      } catch (error) {
        console.error(
          `[reconciliation] parseSession failed for ${row.id}, finalizing as process_gone:`,
          error,
        );
        lifecycle = { status: "ended", endedAt: null, endReason: "process_gone" };
      }

      db.prepare(
        `
        UPDATE sessions
        SET
          status = 'ended',
          ended_at = COALESCE(?, last_event_at),
          end_reason = ?
        WHERE id = ? AND COALESCE(status, '') != 'ended'
        `,
      ).run(lifecycle.endedAt, lifecycle.endReason ?? "process_gone", row.id);

      materializeSessionSummary(row.id);
    } catch (error) {
      console.error(`[reconciliation] failed for session ${row.id}:`, error);
    }
  }
}

export async function reconcileOnStartup(): Promise<void> {
  await reconcileSessionLifecycles();
}

function refreshLastEventAt(row: CandidateSessionRow): void {
  const db = getDb();
  const latest = db
    .prepare(`SELECT MAX(started_at) as ts FROM turns WHERE session_id = ?`)
    .get(row.id) as { ts: string | null } | undefined;
  const ts = latest?.ts;
  if (!ts) return;
  if (ts <= row.lastEventAt) return;
  db.prepare(
    `
    UPDATE sessions
    SET last_event_at = ?
    WHERE id = ? AND COALESCE(status, '') != 'ended'
    `,
  ).run(ts, row.id);
}

function refreshRefFromDisk(ref: ProviderSessionRef): ProviderSessionRef {
  try {
    const stat = statSync(ref.sourcePath);
    return {
      ...ref,
      modifiedAt: stat.mtime,
      sizeBytes: stat.size,
      sourceMtime: stat.mtime,
      sourceSizeBytes: stat.size,
    };
  } catch {
    return ref;
  }
}

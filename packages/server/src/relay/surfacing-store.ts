import type { SurfacedWorkstream, SurfacedUnassigned } from "./types.js";

export interface StoredSurfacing {
  hexcoreId: string;
  workstreams: SurfacedWorkstream[];
  unassigned: SurfacedUnassigned[];
  receivedAt: string;
}

class SurfacingStore {
  /** hexcoreId → latest surfaced state */
  private state = new Map<string, StoredSurfacing>();

  upsert(hexcoreId: string, workstreams: SurfacedWorkstream[], unassigned: SurfacedUnassigned[]): void {
    this.state.set(hexcoreId, {
      hexcoreId,
      workstreams,
      unassigned,
      receivedAt: new Date().toISOString(),
    });
  }

  getByHexcore(hexcoreId: string): StoredSurfacing | undefined {
    return this.state.get(hexcoreId);
  }

  /** Get all surfacing state across all hexcores. */
  getAll(): StoredSurfacing[] {
    return [...this.state.values()];
  }

  /** Get merged workstreams from all hexcores. */
  getAllWorkstreams(): (SurfacedWorkstream & { hexcoreId: string })[] {
    const result: (SurfacedWorkstream & { hexcoreId: string })[] = [];
    for (const [hexcoreId, entry] of this.state) {
      for (const ws of entry.workstreams) {
        result.push({ ...ws, hexcoreId });
      }
    }
    return result;
  }

  remove(hexcoreId: string): void {
    this.state.delete(hexcoreId);
  }
}

export const surfacingStore = new SurfacingStore();

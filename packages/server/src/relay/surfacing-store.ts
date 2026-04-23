import type { SurfacedBranchCard } from "./types.js";

export interface StoredSurfacing {
  hexcoreId: string;
  branches: SurfacedBranchCard[];
  receivedAt: string;
}

class SurfacingStore {
  /** hexcoreId → latest surfaced state */
  private state = new Map<string, StoredSurfacing>();

  upsert(hexcoreId: string, branches: SurfacedBranchCard[]): void {
    this.state.set(hexcoreId, {
      hexcoreId,
      branches,
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

  remove(hexcoreId: string): void {
    this.state.delete(hexcoreId);
  }
}

export const surfacingStore = new SurfacingStore();

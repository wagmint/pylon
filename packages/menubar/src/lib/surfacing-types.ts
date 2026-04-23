// Client-side types mirroring the server's surfacing data model.
// Kept local to avoid pulling in the full server dependency.

export interface SurfacedBranchCard {
  workUnitId: string;
  repo: string;
  branch: string;
  state: "active" | "complete" | "stale";
  commitCount: number;
  filesTouched: string[];
  sessionIds: string[];
  completedAt: string | null;
  archivedAt: string | null;
  prNumber: number | null;
  prTitle: string | null;
  agentCount: number;
  firstSeenAt: string;
  lastActivityAt: string;
}

export interface SurfacedHexcore {
  hexcoreId: string;
  branches: SurfacedBranchCard[];
  receivedAt: string;
}

export interface SurfacingState {
  hexcores: SurfacedHexcore[];
}

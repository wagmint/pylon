// Client-side types mirroring the server's surfacing data model.
// Kept local to avoid pulling in the full server dependency.

export interface SurfacedBranch {
  repo: string;
  branch: string;
  state: string;
  workUnitId: string;
}

export interface SurfacedWorkstream {
  workstreamId: string;
  title: string;
  classification: string;
  workState: string;
  confirmed: boolean;
  stable: boolean;
  branches: SurfacedBranch[];
  agentCount: number;
  filesTouched: string[];
}

export interface SurfacedUnassigned {
  repo: string;
  branch: string;
  state: string;
  workUnitId: string;
  hasFileChanges: boolean;
}

export interface SurfacedHexcore {
  hexcoreId: string;
  workstreams: SurfacedWorkstream[];
  unassigned: SurfacedUnassigned[];
  receivedAt: string;
}

export interface SurfacingState {
  hexcores: SurfacedHexcore[];
}

export type WorkstreamStatusAction = "done" | "dropped";

export interface StatusActionState {
  status: "pending" | "resolved" | "error";
  action: WorkstreamStatusAction;
  error?: string;
}

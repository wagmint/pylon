import { useMemo } from "react";
import type { SurfacingState, SurfacedBranchCard } from "../lib/surfacing-types";

export interface FlatBranch extends SurfacedBranchCard {
  hexcoreId: string;
}

interface UseSurfacingResult {
  branches: FlatBranch[];
}

export function useSurfacing(
  surfacing: SurfacingState | null,
  _connected: boolean,
): UseSurfacingResult {
  const branches = useMemo<FlatBranch[]>(() => {
    if (!surfacing) return [];
    return surfacing.hexcores.flatMap((hc) =>
      hc.branches.map((b) => ({ ...b, hexcoreId: hc.hexcoreId })),
    );
  }, [surfacing]);

  return { branches };
}

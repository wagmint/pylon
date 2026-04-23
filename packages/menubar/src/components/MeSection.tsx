import { useMemo, useState } from "react";
import type { FlatBranch } from "../hooks/useSurfacing";
import { BranchCard } from "./BranchCard";

const statePriority: Record<string, number> = {
  active: 0,
  complete: 1,
  stale: 2,
};

function repoBasename(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

interface MeSectionProps {
  branches: FlatBranch[];
}

export function MeSection({ branches }: MeSectionProps) {
  const [showArchived, setShowArchived] = useState(false);

  const visibleBranches = useMemo(
    () => (showArchived ? branches : branches.filter((b) => b.archivedAt === null)),
    [branches, showArchived],
  );

  const archivedCount = useMemo(
    () => branches.filter((b) => b.archivedAt !== null).length,
    [branches],
  );

  // Group by repo, sorted by repo basename
  const groupedByRepo = useMemo(() => {
    const map = new Map<string, FlatBranch[]>();
    for (const b of visibleBranches) {
      const list = map.get(b.repo) ?? [];
      list.push(b);
      map.set(b.repo, list);
    }

    // Sort branches within each repo: by state priority, then by lastActivityAt desc
    for (const list of map.values()) {
      list.sort((a, b) => {
        const sp = (statePriority[a.state] ?? 9) - (statePriority[b.state] ?? 9);
        if (sp !== 0) return sp;
        return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
      });
    }

    // Sort repos by basename
    return Array.from(map.entries()).sort((a, b) =>
      repoBasename(a[0]).localeCompare(repoBasename(b[0])),
    );
  }, [visibleBranches]);

  if (visibleBranches.length === 0 && archivedCount === 0) {
    return (
      <div className="px-3 py-2">
        <p className="text-[11px] text-dash-text-muted text-center py-3">
          No active branches
        </p>
      </div>
    );
  }

  return (
    <div className="px-3 py-2">
      {groupedByRepo.map(([repo, items]) => (
        <div key={repo}>
          <div className="space-y-0.5">
            {items.map((b) => (
              <BranchCard key={b.workUnitId} branch={b} />
            ))}
          </div>
        </div>
      ))}

      {archivedCount > 0 && (
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="mt-2 w-full text-[10px] text-dash-text-dim hover:text-dash-text-muted transition-colors py-1"
        >
          {showArchived ? "Hide archived" : `Show ${archivedCount} archived`}
        </button>
      )}
    </div>
  );
}

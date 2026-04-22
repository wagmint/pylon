import { useMemo } from "react";
import type { StatusActionState, WorkstreamStatusAction } from "../lib/surfacing-types";
import type { FlatWorkstream, FlatUnassigned } from "../hooks/useSurfacing";
import { WorkstreamRow } from "./WorkstreamRow";

interface MeSectionProps {
  allWorkstreams: FlatWorkstream[];
  allUnassigned: FlatUnassigned[];
  statusActions: Map<string, StatusActionState>;
  onReport: (hexcoreId: string, workstreamId: string, action: WorkstreamStatusAction) => void;
}

export function MeSection({
  allWorkstreams,
  allUnassigned,
  statusActions,
  onReport,
}: MeSectionProps) {
  const stableWorkstreams = useMemo(
    () => allWorkstreams.filter((ws) => ws.stable),
    [allWorkstreams],
  );

  const unstableWorkstreams = useMemo(
    () => allWorkstreams.filter((ws) => !ws.stable),
    [allWorkstreams],
  );

  // Group unassigned branches by repo
  const unassignedByRepo = useMemo(() => {
    const map = new Map<string, FlatUnassigned[]>();
    for (const u of allUnassigned) {
      const list = map.get(u.repo) ?? [];
      list.push(u);
      map.set(u.repo, list);
    }
    return map;
  }, [allUnassigned]);

  // Group unstable workstream branches by repo
  const unstableBranchesByRepo = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const ws of unstableWorkstreams) {
      for (const b of ws.branches) {
        const list = map.get(b.repo) ?? [];
        list.push(b.branch);
        map.set(b.repo, list);
      }
    }
    return map;
  }, [unstableWorkstreams]);

  const hasContent =
    unassignedByRepo.size > 0 ||
    unstableBranchesByRepo.size > 0 ||
    stableWorkstreams.length > 0;

  if (!hasContent) {
    return (
      <div className="px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
          Me
        </span>
        <p className="text-[11px] text-dash-text-muted text-center py-3">
          No active workstreams
        </p>
      </div>
    );
  }

  return (
    <div className="px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wider text-dash-text-muted px-1">
        Me
      </span>

      {/* Unassigned branches grouped by repo */}
      {Array.from(unassignedByRepo).map(([repo, items]) => (
        <div key={`unassigned-${repo}`} className="mt-1.5">
          <p className="text-[10px] text-dash-text-dim px-1">{repo}</p>
          {items.map((item) => (
            <p
              key={item.workUnitId}
              className="text-[10px] text-dash-text-muted font-mono truncate pl-3.5"
            >
              {item.branch}
            </p>
          ))}
        </div>
      ))}

      {/* Unstable workstream branches grouped by repo */}
      {Array.from(unstableBranchesByRepo).map(([repo, branches]) => (
        <div key={`unstable-${repo}`} className="mt-1.5">
          <p className="text-[10px] text-dash-text-dim px-1">{repo}</p>
          {branches.map((branch, i) => (
            <p
              key={`${repo}-${branch}-${i}`}
              className="text-[10px] text-dash-text-muted font-mono truncate pl-3.5"
            >
              {branch}
            </p>
          ))}
        </div>
      ))}

      {/* Stable workstreams */}
      {stableWorkstreams.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {stableWorkstreams.map((ws) => (
            <WorkstreamRow
              key={ws.workstreamId}
              workstream={ws}
              actionState={statusActions.get(ws.workstreamId)}
              onReport={onReport}
            />
          ))}
        </div>
      )}
    </div>
  );
}

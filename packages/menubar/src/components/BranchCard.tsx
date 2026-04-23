import type { FlatBranch } from "../hooks/useSurfacing";

const stateDot: Record<string, string> = {
  active: "bg-dash-green",
  complete: "bg-dash-blue",
  stale: "bg-dash-text-muted",
};

const stateLabel: Record<string, string> = {
  active: "active",
  complete: "merged",
  stale: "stale",
};

function repoBasename(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

interface BranchCardProps {
  branch: FlatBranch;
}

export function BranchCard({ branch }: BranchCardProps) {
  const dotColor = stateDot[branch.state] ?? "bg-dash-text-muted";
  const label = stateLabel[branch.state] ?? branch.state;

  const filesCount = branch.filesTouched.length;

  return (
    <div className="px-3 py-1.5 rounded-lg hover:bg-dash-surface-2 transition-colors">
      {/* Branch name + state */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
          <span className="text-xs text-dash-text font-mono truncate">{branch.branch}</span>
        </div>
        <span className="text-[10px] text-dash-text-muted flex-shrink-0">{label}</span>
      </div>

      {/* Repo */}
      <p className="text-[10px] text-dash-text-dim truncate mt-0.5 pl-3.5">
        {repoBasename(branch.repo)}
      </p>

      {/* Metadata */}
      <p className="text-[10px] text-dash-text-muted mt-0.5 pl-3.5">
        {branch.commitCount} commit{branch.commitCount !== 1 ? "s" : ""} · {filesCount} file{filesCount !== 1 ? "s" : ""} · {branch.agentCount} agent{branch.agentCount !== 1 ? "s" : ""}
      </p>

      {/* PR info */}
      {branch.prNumber != null && (
        <p className="text-[10px] text-dash-text-dim truncate mt-0.5 pl-3.5">
          PR #{branch.prNumber}{branch.prTitle ? `: "${branch.prTitle}"` : ""}
        </p>
      )}
    </div>
  );
}

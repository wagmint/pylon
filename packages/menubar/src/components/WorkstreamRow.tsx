import type { StatusActionState, WorkstreamStatusAction } from "../lib/surfacing-types";
import type { FlatWorkstream } from "../hooks/useSurfacing";

const workStateDot: Record<string, string> = {
  active: "bg-dash-green",
  checkpointed: "bg-dash-text-muted",
  paused: "bg-dash-text-muted",
  shipped: "bg-dash-blue",
};

const workStateLabel: Record<string, string> = {
  active: "in progress",
  checkpointed: "checkpointed",
  paused: "paused",
  shipped: "shipped",
};

/** Only active workstreams accept Done/Dropped actions. */
const actionableStates = new Set(["active"]);

interface WorkstreamRowProps {
  workstream: FlatWorkstream;
  actionState?: StatusActionState;
  onReport: (hexcoreId: string, workstreamId: string, action: WorkstreamStatusAction) => void;
}

export function WorkstreamRow({ workstream, actionState, onReport }: WorkstreamRowProps) {
  const dotColor = workStateDot[workstream.workState] ?? "bg-dash-text-muted";
  const label = workStateLabel[workstream.workState] ?? workstream.workState;

  const branchText = workstream.branches
    .map((b) => `${b.repo}/${b.branch}`)
    .join(", ");

  const filesCount = workstream.filesTouched.length;

  return (
    <div className="px-3 py-1.5 rounded-lg hover:bg-dash-surface-2 transition-colors">
      {/* Title + state */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
          <span className="text-xs text-dash-text truncate">{workstream.title}</span>
        </div>
        <span className="text-[10px] text-dash-text-muted flex-shrink-0">{label}</span>
      </div>

      {/* Branches */}
      {branchText && (
        <p className="text-[10px] text-dash-text-dim font-mono truncate mt-0.5 pl-3.5">
          {branchText}
        </p>
      )}

      {/* Metadata */}
      <p className="text-[10px] text-dash-text-muted mt-0.5 pl-3.5">
        {filesCount} file{filesCount !== 1 ? "s" : ""} · {workstream.agentCount} agent{workstream.agentCount !== 1 ? "s" : ""}
      </p>

      {/* Action area — only actionable workStates get Done/Dropped controls */}
      {actionableStates.has(workstream.workState) && (
        <div className="mt-1 pl-3.5">
          {actionState?.status === "pending" && (
            <span className="text-[10px] text-dash-text-dim">Updating...</span>
          )}

          {actionState?.status === "error" && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-red-400 truncate">{actionState.error}</span>
              <button
                onClick={() => onReport(workstream.hexcoreId, workstream.workstreamId, actionState.action)}
                className="text-[10px] text-dash-blue hover:underline flex-shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {actionState?.status === "resolved" && (
            <span className="text-[10px] text-dash-green">✓</span>
          )}

          {!actionState && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onReport(workstream.hexcoreId, workstream.workstreamId, "done")}
                className="text-[10px] text-dash-text-dim hover:text-dash-green transition-colors px-1.5 py-0.5 rounded border border-dash-border hover:border-dash-green/30"
              >
                Done
              </button>
              <button
                onClick={() => onReport(workstream.hexcoreId, workstream.workstreamId, "dropped")}
                className="text-[10px] text-dash-text-dim hover:text-red-400 transition-colors px-1.5 py-0.5 rounded border border-dash-border hover:border-red-400/30"
              >
                Dropped
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

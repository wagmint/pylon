import { execSync } from "child_process";

export interface GitProjectState {
  projectPath: string;
  branch: string;
  headHash: string;
  dirty: boolean;
  previousHeadHash?: string;
}

interface LastKnownState {
  branch: string;
  headHash: string;
  dirty: boolean;
}

/** In-memory dedup — only emit projects whose state actually changed. */
const lastKnown = new Map<string, LastKnownState>();

/**
 * Poll git state for a set of project paths.
 * Runs a single combined `git rev-parse` + `git status` per project.
 * Returns only projects whose state changed since last call.
 * Includes `previousHeadHash` so downstream consumers can detect changes
 * even without their own baseline (e.g. after hexcore restart).
 *
 * Silently skips non-git directories (matches collisions.ts pattern).
 */
export function pollGitState(projectPaths: string[]): GitProjectState[] {
  const changed: GitProjectState[] = [];

  for (const projectPath of projectPaths) {
    try {
      // Combined command: branch + HEAD hash + porcelain status
      const output = execSync(
        "git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --porcelain",
        {
          cwd: projectPath,
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const lines = output.split("\n");
      const branch = lines[0]?.trim() ?? "";
      const headHash = lines[1]?.trim() ?? "";
      // Dirty if any porcelain output beyond the first two lines
      const dirty = lines.slice(2).some((l) => l.trim().length > 0);

      if (!branch || !headHash) continue;

      const prev = lastKnown.get(projectPath);
      const current: LastKnownState = { branch, headHash, dirty };

      if (
        prev &&
        prev.branch === current.branch &&
        prev.headHash === current.headHash &&
        prev.dirty === current.dirty
      ) {
        continue; // No change
      }

      lastKnown.set(projectPath, current);
      changed.push({
        projectPath,
        branch,
        headHash,
        dirty,
        previousHeadHash: prev?.headHash,
      });
    } catch {
      // Non-git directory or git command failed — silently skip
    }
  }

  return changed;
}

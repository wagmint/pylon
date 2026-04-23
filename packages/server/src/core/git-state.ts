import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { join } from "path";

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

/** Cache: project path → resolved git working directory (or null if no repo found). */
const gitCwdCache = new Map<string, string | null>();

/**
 * Resolve a valid git working directory for a project path.
 * Handles three cases:
 *  1. Path is a git repo root or inside a git repo (git rev-parse succeeds)
 *  2. Path is a parent of git repos (checks immediate children for .git)
 * Result is cached for the lifetime of the process.
 */
export function resolveGitCwd(projectPath: string): string | null {
  const cached = gitCwdCache.get(projectPath);
  if (cached !== undefined) return cached;

  // Case 1: path is inside a git repo (or is the repo root)
  try {
    execSync("git rev-parse --show-toplevel", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    gitCwdCache.set(projectPath, projectPath);
    return projectPath;
  } catch {
    // Not inside a git repo — check children
  }

  // Case 2: path is a parent directory containing git repos
  try {
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      try {
        statSync(join(projectPath, entry.name, ".git"));
        const childPath = join(projectPath, entry.name);
        gitCwdCache.set(projectPath, childPath);
        return childPath;
      } catch {
        continue;
      }
    }
  } catch {
    // Can't read directory
  }

  gitCwdCache.set(projectPath, null);
  return null;
}

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
      const gitCwd = resolveGitCwd(projectPath);
      if (!gitCwd) continue;

      // Combined command: branch + HEAD hash + porcelain status
      const output = execSync(
        "git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --porcelain",
        {
          cwd: gitCwd,
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

/** Read the last-known branch for a project without running git. */
export function getLastKnownBranch(projectPath: string): string | undefined {
  return lastKnown.get(projectPath)?.branch;
}

/** Read the last-known state (branch + hash) for a project without running git. */
export function getLastKnownState(projectPath: string): { branch: string; headHash: string } | undefined {
  const state = lastKnown.get(projectPath);
  if (!state) return undefined;
  return { branch: state.branch, headHash: state.headHash };
}

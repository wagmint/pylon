import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { join } from "path";

export interface GitProjectState {
  projectPath: string;
  repoRoot: string;
  branch: string;
  headHash: string;
  dirty: boolean;
  previousHeadHash?: string;
  previousBranch?: string;
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
    // Resolve all git working directories for this project path.
    // Case 1: path itself is a git repo → poll it directly.
    // Case 2: path is a parent of git repos → poll ALL children with .git.
    const gitCwds = resolveAllGitCwds(projectPath);

    for (const gitCwd of gitCwds) {
      try {
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

        const prev = lastKnown.get(gitCwd);
        const current: LastKnownState = { branch, headHash, dirty };

        if (
          prev &&
          prev.branch === current.branch &&
          prev.headHash === current.headHash &&
          prev.dirty === current.dirty
        ) {
          continue; // No change
        }

        lastKnown.set(gitCwd, current);
        changed.push({
          projectPath,
          repoRoot: gitCwd,
          branch,
          headHash,
          dirty,
          previousHeadHash: prev?.headHash,
          previousBranch: prev?.branch,
        });
      } catch {
        // Non-git directory or git command failed — silently skip
      }
    }
  }

  return changed;
}

/** Cache: project path → resolved git working directories. */
const allGitCwdsCache = new Map<string, string[]>();

/**
 * Resolve ALL git working directories for a project path.
 * If the path itself is a git repo, returns [path].
 * If the path is a parent of git repos, returns all children with .git.
 * Result is cached for the lifetime of the process.
 */
function resolveAllGitCwds(projectPath: string): string[] {
  const cached = allGitCwdsCache.get(projectPath);
  if (cached !== undefined) return cached;

  // Case 1: path is inside a git repo (or is the repo root)
  try {
    execSync("git rev-parse --show-toplevel", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    allGitCwdsCache.set(projectPath, [projectPath]);
    return [projectPath];
  } catch {
    // Not inside a git repo — check children
  }

  // Case 2: path is a parent directory containing git repos — collect ALL
  const results: string[] = [];
  try {
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      try {
        statSync(join(projectPath, entry.name, ".git"));
        results.push(join(projectPath, entry.name));
      } catch {
        continue;
      }
    }
  } catch {
    // Can't read directory
  }

  allGitCwdsCache.set(projectPath, results);
  return results;
}

/** Read the last-known branch for a project without running git. */
export function getLastKnownBranch(projectPath: string): string | undefined {
  return lastKnown.get(projectPath)?.branch;
}

/** Resolve current branch by running git. Falls back when in-memory cache is empty. */
export function resolveCurrentBranch(projectPath: string): string | null {
  const gitCwd = resolveGitCwd(projectPath);
  if (!gitCwd) return null;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: gitCwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

/** Read the last-known state (branch + hash) for a project without running git. */
export function getLastKnownState(projectPath: string): { branch: string; headHash: string } | undefined {
  const state = lastKnown.get(projectPath);
  if (!state) return undefined;
  return { branch: state.branch, headHash: state.headHash };
}

const SAFE_REF_RE = /^[a-zA-Z0-9/_.\-@]+$/;

/** Count commits ahead of defaultBranch for a given branch. Returns null on failure. */
export function countCommitsAhead(repoRoot: string, branch: string, defaultBranch: string): number | null {
  if (!SAFE_REF_RE.test(branch) || branch.includes("..")) return null;
  if (!SAFE_REF_RE.test(defaultBranch) || defaultBranch.includes("..")) return null;
  try {
    const out = execSync(`git rev-list --count ${defaultBranch}..${branch}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const count = parseInt(out, 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

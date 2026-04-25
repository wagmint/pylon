import { execSync } from "child_process";
import { closeSync, openSync, readSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";

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
export function resolveAllGitCwds(projectPath: string): string[] {
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

// ─── Project Path Normalization ──────────────────────────────────────────────

/** Cache: path → git repo root (or null). */
const gitRootCache = new Map<string, string | null>();

/**
 * Resolve the git repo root for a path by capturing `git rev-parse --show-toplevel`.
 * Unlike `resolveGitCwd` which discards the output, this returns the actual repo root.
 * Cached for the lifetime of the process.
 */
export function resolveGitRoot(path: string): string | null {
  const cached = gitRootCache.get(path);
  if (cached !== undefined) return cached;

  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd: path,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    gitRootCache.set(path, root || null);
    return root || null;
  } catch {
    gitRootCache.set(path, null);
    return null;
  }
}

/**
 * Normalize a session's projectPath to the git repo root.
 *
 * Three-tier resolution:
 * 1. `resolveGitRoot(projectPath)` — path is inside a repo, normalize to root
 * 2. `resolveAllGitCwds(projectPath)` — path is a parent of repos
 *    - 0 children: return as-is (not a git context)
 *    - 1 child: return the single child (unambiguous)
 *    - N children: go to step 3
 * 3. Transcript peek — read first 16 KB of the JSONL, count mentions of each
 *    child repo basename. If exactly one child is mentioned, return it.
 *    Otherwise return projectPath as-is.
 */
export function normalizeProjectPath(projectPath: string, transcriptPath?: string): string {
  // Tier 1: path is inside (or is) a git repo
  const root = resolveGitRoot(projectPath);
  if (root) return root;

  // Tier 2: path is a parent of git repos
  const children = resolveAllGitCwds(projectPath);
  if (children.length === 0) return projectPath;
  if (children.length === 1) return children[0];

  // Tier 3: multiple children — peek at transcript to disambiguate
  if (!transcriptPath) return projectPath;

  try {
    const PEEK_BYTES = 16384;
    const buf = Buffer.alloc(PEEK_BYTES);
    const fd = openSync(transcriptPath, "r");
    let bytesRead: number;
    try {
      bytesRead = readSync(fd, buf, 0, PEEK_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    const head = buf.toString("utf-8", 0, bytesRead);

    let matched: string | null = null;
    let matchCount = 0;

    for (const child of children) {
      const name = basename(child);
      if (head.includes(name)) {
        matched = child;
        matchCount++;
      }
    }

    if (matchCount === 1 && matched) return matched;
  } catch {
    // Can't read transcript — fall through
  }

  return projectPath;
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

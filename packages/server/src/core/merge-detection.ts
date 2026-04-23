import { execSync } from "child_process";
import type { BranchRegistryRow } from "../storage/branch-registry.js";

// ─── Shell Injection Guard ───────────────────────────────────────────────────

const SAFE_REF_RE = /^[a-zA-Z0-9/_.\-@]+$/;

function isSafeRef(ref: string): boolean {
  return SAFE_REF_RE.test(ref) && !ref.includes("..");
}

// ─── Default Branch Resolution ───────────────────────────────────────────────

const defaultBranchCache = new Map<string, string>();

export function resolveDefaultBranch(repoRoot: string): string | null {
  const cached = defaultBranchCache.get(repoRoot);
  if (cached) return cached;

  // Method 1: symbolic-ref
  try {
    const out = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // "refs/remotes/origin/main" → "origin/main"
    const match = out.match(/refs\/remotes\/(.+)/);
    if (match) {
      defaultBranchCache.set(repoRoot, match[1]);
      return match[1];
    }
  } catch { /* fallback */ }

  // Method 2: check origin/main
  try {
    execSync("git rev-parse --verify refs/remotes/origin/main", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    defaultBranchCache.set(repoRoot, "origin/main");
    return "origin/main";
  } catch { /* fallback */ }

  // Method 3: check origin/master
  try {
    execSync("git rev-parse --verify refs/remotes/origin/master", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    defaultBranchCache.set(repoRoot, "origin/master");
    return "origin/master";
  } catch { /* fallback */ }

  return null;
}

// ─── Merge Detection ─────────────────────────────────────────────────────────

export type MergeMethod = "ancestry" | "pr_api" | "none";

export interface MergeDetectionResult {
  merged: boolean;
  method: MergeMethod;
  headHash: string | null;
  commitCount: number | null;
  prNumber?: number;
  prTitle?: string;
  /** True when both local and remote branch are gone — candidate for archiving. */
  branchGone: boolean;
}

function gitExec(cmd: string, cwd: string, timeoutMs = 5000): string | null {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function localBranchExists(repoRoot: string, branch: string): boolean {
  return gitExec(`git rev-parse --verify refs/heads/${branch}`, repoRoot) !== null;
}

function remoteBranchExists(repoRoot: string, branch: string): boolean {
  return gitExec(`git rev-parse --verify refs/remotes/origin/${branch}`, repoRoot) !== null;
}

function checkAncestry(repoRoot: string, commitHash: string, defaultBranch: string): boolean {
  if (!isSafeRef(defaultBranch)) return false;
  const result = gitExec(
    `git merge-base --is-ancestor ${commitHash} ${defaultBranch}`,
    repoRoot,
    5000,
  );
  // merge-base --is-ancestor exits 0 if true, 1 if false — gitExec returns null on non-zero
  return result !== null;
}

interface PrInfo {
  number: number;
  title: string;
}

function checkPrMerged(repoRoot: string, branch: string): PrInfo | null {
  if (!isSafeRef(branch)) return null;
  const out = gitExec(
    `gh pr list --head ${branch} --state merged --json number,title --limit 1`,
    repoRoot,
    10000,
  );
  if (!out) return null;
  try {
    const parsed = JSON.parse(out) as Array<{ number: number; title: string }>;
    if (parsed.length > 0) {
      return { number: parsed[0].number, title: parsed[0].title };
    }
  } catch { /* invalid JSON */ }
  return null;
}

export function detectMergeForBranch(
  entry: BranchRegistryRow,
  defaultBranch: string,
): MergeDetectionResult {
  const { repoRoot, branch, lastHeadHash } = entry;

  if (!isSafeRef(branch) || !isSafeRef(defaultBranch)) {
    return { merged: false, method: "none", headHash: null, commitCount: null, branchGone: false };
  }

  const hasLocal = localBranchExists(repoRoot, branch);

  if (hasLocal) {
    // Get current HEAD hash
    const headHash = gitExec(`git rev-parse refs/heads/${branch}`, repoRoot);
    if (!headHash) {
      return { merged: false, method: "none", headHash: null, commitCount: null, branchGone: false };
    }

    // Count commits ahead of default branch
    const countStr = gitExec(
      `git rev-list --count ${defaultBranch}..${branch}`,
      repoRoot,
    );
    const commitCount = countStr ? parseInt(countStr, 10) : null;

    // Guard: 0 commits ahead means nothing to check
    if (commitCount === 0) {
      return { merged: false, method: "none", headHash, commitCount: 0, branchGone: false };
    }

    // Method 1: Ancestry check
    if (checkAncestry(repoRoot, headHash, defaultBranch)) {
      return { merged: true, method: "ancestry", headHash, commitCount, branchGone: false };
    }

    // Method 2: PR API
    const pr = checkPrMerged(repoRoot, branch);
    if (pr) {
      return { merged: true, method: "pr_api", headHash, commitCount, branchGone: false, prNumber: pr.number, prTitle: pr.title };
    }

    return { merged: false, method: "none", headHash, commitCount, branchGone: false };
  }

  // Branch is gone locally
  const effectiveHash = lastHeadHash;

  // Try ancestry with last known hash
  if (effectiveHash && isSafeRef(effectiveHash)) {
    if (checkAncestry(repoRoot, effectiveHash, defaultBranch)) {
      return { merged: true, method: "ancestry", headHash: effectiveHash, commitCount: null, branchGone: true };
    }
  }

  // Try PR API
  const pr = checkPrMerged(repoRoot, branch);
  if (pr) {
    return { merged: true, method: "pr_api", headHash: effectiveHash, commitCount: null, branchGone: true, prNumber: pr.number, prTitle: pr.title };
  }

  // Check if remote is also gone → archive signal
  const hasRemote = remoteBranchExists(repoRoot, branch);
  if (!hasRemote) {
    return { merged: false, method: "none", headHash: effectiveHash, commitCount: null, branchGone: true };
  }

  return { merged: false, method: "none", headHash: effectiveHash, commitCount: null, branchGone: false };
}

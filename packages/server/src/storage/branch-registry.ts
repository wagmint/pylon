import { getDb } from "./db.js";

export type BranchState = "active" | "complete" | "stale";

export interface BranchRegistryRow {
  id: number;
  projectPath: string;
  repoRoot: string;
  branch: string;
  defaultBranch: string | null;
  state: BranchState;
  firstSeenAt: string;
  lastActivityAt: string;
  lastHeadHash: string | null;
  commitCount: number;
  completedAt: string | null;
  archivedAt: string | null;
  mergeCheckedAt: string | null;
  prNumber: number | null;
  prTitle: string | null;
  hexcoreId: string | null;
  operatorId: string | null;
  workUnitId: string | null;
  completionSignaledAt: string | null;
}

const IGNORED_BRANCHES = new Set([
  "main", "master", "dev", "develop", "staging", "production", "HEAD",
]);

export function isIgnoredBranch(branch: string): boolean {
  return IGNORED_BRANCHES.has(branch);
}

export interface UpsertBranchInput {
  projectPath: string;
  repoRoot: string;
  branch: string;
  headHash?: string;
  hexcoreId?: string;
  operatorId?: string;
  workUnitId?: string;
}

export function upsertBranch(input: UpsertBranchInput): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO branch_registry(
      project_path, repo_root, branch, state,
      first_seen_at, last_activity_at, last_head_hash,
      hexcore_id, operator_id, work_unit_id
    )
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_path, branch) DO UPDATE SET
      last_activity_at = excluded.last_activity_at,
      last_head_hash = COALESCE(excluded.last_head_hash, branch_registry.last_head_hash),
      hexcore_id = COALESCE(excluded.hexcore_id, branch_registry.hexcore_id),
      operator_id = COALESCE(excluded.operator_id, branch_registry.operator_id),
      work_unit_id = COALESCE(excluded.work_unit_id, branch_registry.work_unit_id),
      archived_at = NULL,
      state = CASE
        WHEN branch_registry.state = 'complete' THEN 'complete'
        ELSE 'active'
      END
  `).run(
    input.projectPath,
    input.repoRoot,
    input.branch,
    now,
    now,
    input.headHash ?? null,
    input.hexcoreId ?? null,
    input.operatorId ?? null,
    input.workUnitId ?? null,
  );
}

/**
 * Enrich a branch row with hexcore-owned fields only.
 * Does NOT touch lifecycle signals (state, last_activity_at, archived_at, last_head_hash)
 * which are owned by Hexdeck's local git poller.
 * No-op if the branch row doesn't exist yet (surfacing alone doesn't create rows).
 */
export function enrichBranchFromSurfacing(
  projectPath: string,
  branch: string,
  hexcoreId: string,
  workUnitId?: string,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry
    SET hexcore_id = COALESCE(?, hexcore_id),
        work_unit_id = COALESCE(?, work_unit_id)
    WHERE project_path = ? AND branch = ?
  `).run(hexcoreId, workUnitId ?? null, projectPath, branch);
}

const SELECT_COLS = `
  id,
  project_path AS projectPath,
  repo_root AS repoRoot,
  branch,
  default_branch AS defaultBranch,
  state,
  first_seen_at AS firstSeenAt,
  last_activity_at AS lastActivityAt,
  last_head_hash AS lastHeadHash,
  commit_count AS commitCount,
  completed_at AS completedAt,
  archived_at AS archivedAt,
  merge_checked_at AS mergeCheckedAt,
  pr_number AS prNumber,
  pr_title AS prTitle,
  hexcore_id AS hexcoreId,
  operator_id AS operatorId,
  work_unit_id AS workUnitId,
  completion_signaled_at AS completionSignaledAt
`;

export function getMergeCheckCandidates(): BranchRegistryRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT ${SELECT_COLS}
    FROM branch_registry
    WHERE state IN ('active', 'stale')
      AND commit_count > 0
  `).all() as BranchRegistryRow[];
}

export function markComplete(
  id: number,
  method: string,
  prNumber?: number,
  prTitle?: string,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry
    SET state = 'complete',
        completed_at = ?,
        pr_number = COALESCE(?, pr_number),
        pr_title = COALESCE(?, pr_title)
    WHERE id = ?
  `).run(new Date().toISOString(), prNumber ?? null, prTitle ?? null, id);
  console.log(`[branch-registry] marked #${id} complete via ${method}`);
}

export function markStale(id: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry
    SET state = 'stale'
    WHERE id = ? AND state = 'active'
  `).run(id);
}

export function updateMergeCheckedAt(id: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry SET merge_checked_at = ? WHERE id = ?
  `).run(new Date().toISOString(), id);
}

export function updateDefaultBranch(id: number, ref: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry SET default_branch = ? WHERE id = ?
  `).run(ref, id);
}

export function updateHeadHash(id: number, hash: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry SET last_head_hash = ? WHERE id = ?
  `).run(hash, id);
}

export function updateCommitCount(id: number, count: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry SET commit_count = ? WHERE id = ?
  `).run(count, id);
}

export function setCommitCountByKey(projectPath: string, branch: string, count: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry
    SET commit_count = ?
    WHERE project_path = ? AND branch = ?
  `).run(count, projectPath, branch);
}

export function seedCommitCountByKey(projectPath: string, branch: string, count: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry
    SET commit_count = ?
    WHERE project_path = ? AND branch = ? AND commit_count = 0
  `).run(count, projectPath, branch);
}

export function archiveBranch(id: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry SET archived_at = ? WHERE id = ?
  `).run(new Date().toISOString(), id);
  console.log(`[branch-registry] archived #${id}`);
}

export function getStaleEligible(staleTtlMs: number): BranchRegistryRow[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - staleTtlMs).toISOString();
  return db.prepare(`
    SELECT ${SELECT_COLS}
    FROM branch_registry
    WHERE state = 'active'
      AND last_activity_at < ?
  `).all(cutoff) as BranchRegistryRow[];
}

export function getUnsignaledCompletions(): BranchRegistryRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT ${SELECT_COLS}
    FROM branch_registry
    WHERE state = 'complete'
      AND completion_signaled_at IS NULL
  `).all() as BranchRegistryRow[];
}

export function markCompletionSignaled(id: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE branch_registry SET completion_signaled_at = ? WHERE id = ?
  `).run(new Date().toISOString(), id);
}

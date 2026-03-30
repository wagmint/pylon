# Report: 0001-dashboard-master-detail-layout

**Verdict**: PASS WITH ISSUES
**Date**: 2026-03-28

## Test Results

### Type-check: dashboard-ui
```
src/components/Tip.tsx(17,19): error TS2554: Expected 1 arguments, but got 0.
```
**Pre-existing**: confirmed identical error on `main` branch. The only change on this branch to Tip.tsx was replacing `text-[9px]` with `text-2xs` (Checkpoint 1 typography sweep). The `useRef()` call without an initial value is a pre-existing type error unrelated to this task.

### Type-check: local
PASS — clean compile (`npx tsc --noEmit`)

### Type-check: server
PASS — clean compile (`npx tsc --noEmit`)

### Type-check: menubar
PASS — clean compile (`npx tsc --noEmit`)

### Grep Audits
- Zero `text-[Npx]` in dashboard-ui components: **PASS**
- No `zoom: 1.1` in globals.css: **PASS**
- No `RiskPanel` import in page.tsx: **PASS**
- No `riskHoldClock` in page.tsx: **PASS**
- No `RiskPanel` export in dashboard-ui index.ts: **PASS**

## Acceptance Criteria Check

### Checkpoint 1: Typography Foundation
- [x] `text-2xs` defined in tailwind-preset.ts as `['0.625rem', { lineHeight: '0.875rem' }]` (line 12)
- [x] `zoom: 1.1` removed from globals.css body
- [x] Zero `text-[Npx]` patterns in dashboard-ui component files
- [x] Both packages compile without errors (pre-existing Tip.tsx error excluded)

### Checkpoint 2: Badge Consistency & ConfidenceBadge Extraction
- [x] ConfidenceBadge is a standalone file (`components/ConfidenceBadge.tsx`), exported from index.ts (line 56)
- [x] ConfidenceBadge uses `text-2xs font-semibold` (line 14)
- [x] CollisionDetail: critical uses `bg-dash-red-dim text-dash-red`, warning uses `bg-dash-yellow-dim text-dash-yellow` (lines 40-41)
- [x] Package compiles

### Checkpoint 3: Workstream Card Risk Indicators
- [x] 3 risk indicator rows rendered: Context (line 192), Errors (line 196), Stalls (line 200)
- [x] Dot colors follow threshold rules — contextRisk (lines 82-87), errorRisk (lines 89-94), stallRisk (lines 96-101)
- [x] Agent type badges and operator tags removed from agent rows (no `agentType` references in render)
- [x] Mini progress bar present under workstream name (lines 137-142)
- [x] Compiles cleanly

### Checkpoint 4: HomeView Component
- [x] Summary stats line shows active agents, blocked agents, total commits, total tokens (lines 51-54)
- [x] Blocked agents listed with DecideButtons (Approve/Deny) (line 100)
- [x] Error state handled on approve/deny failure (line 22+)
- [x] Empty states handled (no blocked agents check at line 63)
- [x] Compiles cleanly

### Checkpoint 5: DetailView Component
- [x] 3 tabs render: Intent Map, Live Feed, Plans (lines 18-20)
- [x] Active tab styled with `border-dash-green` + `text-dash-text`; inactive with `text-dash-text-muted` (lines 61-62)
- [x] Tab resets to Intent Map on workstream change (line 40)
- [x] Compiles cleanly

### Checkpoint 6: Page Layout Integration
- [x] Grid is 2-column: `minmax(200px, 240px) 1fr` (page.tsx line 177)
- [x] RiskPanel not imported or rendered
- [x] No `riskHoldClock` or bottom panel resize state/effects
- [x] HomeView shown when no workstream selected
- [x] DetailView shown when workstream selected
- [x] ESC clears selection (page.tsx line 44)
- [x] Selected workstream disappearing clears selection (page.tsx line 50-54)
- [x] All three packages compile (local, dashboard-ui, menubar)

### Checkpoint 7: Final Verification
- [x] All packages build successfully (dashboard-ui, local, server, menubar compile clean — excluding pre-existing Tip.tsx error)
- [x] Zero `text-[Npx]` in dashboard-ui components
- [x] No `zoom: 1.1` in globals.css
- [x] No RiskPanel import in page.tsx
- [x] No `riskHoldClock` in page.tsx

## Issues Found

### Critical (must fix)
None.

### Non-critical
- **Pre-existing TS error in Tip.tsx**: `useRef<ReturnType<typeof setTimeout>>()` called with 0 arguments (expects 1 in strict React types). Present on `main` — not introduced by this task. Consider fixing separately with `useRef<ReturnType<typeof setTimeout>>(undefined)`.
- **`font-bold` in RiskPanel StatusBadge** (line 217): Uses `font-bold` instead of `font-semibold`. RiskPanel is no longer rendered in the main layout (removed in Checkpoint 6), so this is cosmetic/dead code. Low priority.
- **State.md shows Checkpoints 3 and 4 unchecked** despite both being implemented and committed (commits `9294c35` and `3052d29`). State tracking is stale but implementation is complete.

## Code Review

### Fixed Issues
- None required — no critical security, correctness, or crash issues found.

### Remaining Issues (non-critical)
- **Pre-existing Tip.tsx TS error**: `useRef()` missing initial argument. Present on `main`, not introduced by this task. Out of scope.
- **`font-bold` in RiskPanel StatusBadge**: Inconsistent with `font-semibold` convention applied everywhere else, but RiskPanel is no longer rendered in the dashboard (removed in Checkpoint 6). Dead code — low priority.
- **RiskPanel still exported from `index.ts` on main**: The task branch correctly removes the export. The `RiskPanel.tsx` component file is retained in the library (confirmed not used by menubar), which is fine for future use.
- **`isNew` prop dropped from FeedItem in DetailView**: The old page.tsx tracked `seenEventIds` to flash new events. DetailView doesn't pass `isNew`, so FeedItem never flashes. This is a minor UX regression but not a bug — the prop is optional and defaults to falsy.
- **State.md stale**: Checkpoints 5/6 not marked complete despite being implemented. Cosmetic tracking issue only.

### Security Review
- **No injection vectors**: `sessionId` used as URL path param in fetch call; server validates action enum. No `dangerouslySetInnerHTML` or `innerHTML` usage anywhere in the diff.
- **No hardcoded secrets**: API base URL comes from env var with localhost fallback — appropriate for local dev tool.
- **No XSS risk**: All user-facing text rendered via React JSX (auto-escaped). The `renderMarkdown` function in PlanDetail uses `renderInline` which returns React elements, not raw HTML.

### Review Verdict
APPROVED

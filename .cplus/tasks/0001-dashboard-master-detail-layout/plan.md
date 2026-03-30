# Plan: Dashboard Master-Detail Layout Overhaul

## Checkpoint 1: Typography Foundation

**Description**: Define `text-2xs` in the tailwind preset, remove `zoom: 1.1` from globals.css, and sweep all component files to replace arbitrary `text-[Npx]` font sizes with the 4-tier scale (`text-2xs`, `text-xs`, `text-sm`, `text-base`). This is done first because every subsequent checkpoint builds on the new type scale.
**Files**: `packages/dashboard-ui/src/tailwind-preset.ts`, `packages/local/src/app/globals.css`, all component files in `packages/dashboard-ui/src/components/` that use `text-[` patterns
**Test command**: `cd packages/dashboard-ui && npx tsc --noEmit && cd ../local && npx tsc --noEmit && grep -r 'text-\[' packages/dashboard-ui/src/components/ | grep -v node_modules | grep -c 'px\]'` (should be 0)
**Acceptance criteria**:
- `text-2xs` defined in tailwind-preset.ts as `['0.625rem', { lineHeight: '0.875rem' }]`
- `zoom: 1.1` removed from globals.css body
- Zero `text-[Npx]` patterns in dashboard-ui component files
- Both packages compile without errors
**Dependencies**: None

## Checkpoint 2: Badge Consistency & ConfidenceBadge Extraction

**Description**: Extract `ConfidenceBadge` from PlanDetail into its own file in dashboard-ui. Standardize all badges across WorkstreamNode, PlanDetail, DeviationItem, TopBar, AgentCard, and FeedItem to use `text-2xs font-semibold`. Fix CollisionDetail severity styling so critical uses red and warning uses yellow.
**Files**: `packages/dashboard-ui/src/components/ConfidenceBadge.tsx` (new), `packages/dashboard-ui/src/components/PlanDetail.tsx`, `packages/dashboard-ui/src/components/CollisionDetail.tsx`, `packages/dashboard-ui/src/components/WorkstreamNode.tsx`, `packages/dashboard-ui/src/components/DeviationItem.tsx`, `packages/dashboard-ui/src/components/TopBar.tsx`, `packages/dashboard-ui/src/components/AgentCard.tsx`, `packages/dashboard-ui/src/components/FeedItem.tsx`, `packages/dashboard-ui/src/index.ts`
**Test command**: `cd packages/dashboard-ui && npx tsc --noEmit && grep -rn 'font-bold' src/components/ | grep -v 'font-semibold'` (verify no badge-context font-bold remains)
**Acceptance criteria**:
- ConfidenceBadge is a standalone file, exported from index.ts
- All badge elements use `text-2xs font-semibold`
- CollisionDetail: critical severity uses `bg-dash-red-dim text-dash-red`, warning uses `bg-dash-yellow-dim text-dash-yellow`
- Package compiles
**Dependencies**: Checkpoint 1

## Checkpoint 3: Workstream Card Risk Indicators

**Description**: Add vertical traffic light risk indicators (Context, Errors, Stalls) to WorkstreamNode cards. Compute context (worst-case agent `contextUsagePct`), errors (`WorkstreamRisk.errorRate`), and stalls (total `spinningSignals.length` across agents). Apply green/yellow/red dot coloring per spec thresholds. Remove agent type badges and operator tags from agent rows. Add mini progress bar under workstream name.
**Files**: `packages/dashboard-ui/src/components/WorkstreamNode.tsx`
**Test command**: `cd packages/dashboard-ui && npx tsc --noEmit`
**Acceptance criteria**:
- 3 risk indicator rows rendered: Context, Errors, Stalls
- Dot colors follow threshold rules (context: <60% green, 60-80% yellow, >=80% red; errors: <5% green, 5-15% yellow, >=15% red; stalls: 0 green, 1 yellow, 2+ red)
- Agent type badges and operator tags removed from agent rows
- Mini progress bar present under workstream name
- Compiles cleanly
**Dependencies**: Checkpoint 1

## Checkpoint 4: HomeView Component

**Description**: Create `HomeView.tsx` in `packages/local/src/app/`. Renders summary stats (active agents, blocked agents, total commits, total tokens from `DashboardSummary`) and a blocked agents panel with Approve/Deny buttons using the existing `DecideButtons` component. Show error feedback on decide failures. Show "No agents waiting for approval" when none are blocked. Fall through to existing empty state when no workstreams exist.
**Files**: `packages/local/src/app/HomeView.tsx` (new)
**Test command**: `cd packages/local && npx tsc --noEmit`
**Acceptance criteria**:
- Summary stats line shows active agents, blocked agents, total commits, total tokens
- Blocked agents listed with tool name, description, and Approve/Deny buttons
- Error state shown on approve/deny failure
- Empty states handled (no blocked agents, no workstreams)
- Compiles cleanly
**Dependencies**: Checkpoint 1

## Checkpoint 5: DetailView Component

**Description**: Create `DetailView.tsx` in `packages/local/src/app/`. Renders a 3-tab layout (Intent Map, Live Feed, Plans). Intent Map tab shows WorkstreamNode at full width filtered to selected workstream. Live Feed tab shows FeedItems filtered to selected workstream. Plans tab shows PlanDetail for selected workstream. Active tab has green bottom border; inactive tabs are muted. Default tab is Intent Map. Tab resets to Intent Map when workstream changes.
**Files**: `packages/local/src/app/DetailView.tsx` (new)
**Test command**: `cd packages/local && npx tsc --noEmit`
**Acceptance criteria**:
- 3 tabs render: Intent Map, Live Feed, Plans
- Active tab styled with `border-dash-green` + `text-dash-text`; inactive with `text-dash-text-muted`
- Content filters to selected workstream
- Tab resets to Intent Map on workstream change
- Compiles cleanly
**Dependencies**: Checkpoints 1, 2 (for PlanDetail changes)

## Checkpoint 6: Page Layout Integration

**Description**: Rewrite `packages/local/src/app/page.tsx` to use the 2-column master-detail layout. Replace 3-column grid with `minmax(200px, 240px) 1fr`. Remove RiskPanel import, bottom panel resize logic, and `riskHoldClock` interval. Add workstream selection state. Render HomeView when nothing is selected, DetailView when a workstream is selected. Add ESC key handler to clear selection. Handle selected workstream disappearing from state. Remove RiskPanel from dashboard-ui exports.
**Files**: `packages/local/src/app/page.tsx`, `packages/dashboard-ui/src/index.ts`
**Test command**: `cd packages/local && npx tsc --noEmit && cd ../menubar && npx tsc --noEmit`
**Acceptance criteria**:
- Grid is 2-column: `minmax(200px, 240px) 1fr`
- RiskPanel not imported or rendered
- No `riskHoldClock` or bottom panel resize state/effects
- HomeView shown when no workstream selected
- DetailView shown when workstream selected
- ESC clears selection
- Selected workstream disappearing clears selection
- All three packages compile (local, dashboard-ui, menubar)
**Dependencies**: Checkpoints 3, 4, 5

## Checkpoint 7: Final Verification

**Description**: Full build verification across all packages. Grep audit for remaining `text-[` pixel patterns, `zoom:`, RiskPanel references in page.tsx, and `riskHoldClock`. Verify no regressions in menubar build.
**Files**: All modified files (read-only verification)
**Test command**: `npm run build --workspaces 2>&1 | tail -20` (or equivalent workspace build command)
**Acceptance criteria**:
- All packages build successfully (dashboard-ui, local, menubar)
- Zero `text-[Npx]` in dashboard-ui components
- No `zoom: 1.1` in globals.css
- No RiskPanel import in page.tsx
- No `riskHoldClock` in page.tsx
**Dependencies**: Checkpoint 6

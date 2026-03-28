# Task: Dashboard Master-Detail Layout Overhaul

**Spec**: .cplus/specs/0001-dashboard-master-detail-layout.md
**Task ID**: 0001-dashboard-master-detail-layout
**Created**: 2026-03-28

## Goal

Restructure the hexdeck dashboard from a 3-column layout into a 2-column master-detail pattern. The left panel shows workstream cards with embedded risk indicators (traffic lights for context, errors, stalls). The right panel shows either an aggregate home view (summary stats + blocked agents with approve/deny) or a tabbed detail view (Intent Map / Live Feed / Plans) for the selected workstream. Typography is standardized to a 4-tier scale and the global zoom hack is removed.

## Non-Goals

- Mobile or tablet responsive design (below 1280px)
- Dark/light theme toggle
- Backend API changes or new endpoints
- State management refactoring
- Accessibility overhaul (ARIA, contrast, reduced-motion)
- New data fetching patterns or caching
- Menubar app layout changes

## Constraints

- No backend changes — existing SSE `/api/dashboard/stream` and `DashboardState` type are unchanged
- All changes must compile across `packages/dashboard-ui`, `packages/local`, and `packages/menubar`
- Optimized for 1280-1440px laptop viewports
- All body text >= 10px (no text smaller than `text-2xs`)
- Removing `riskHoldClock` interval must not break any other behavior
- RiskPanel is confirmed not used by menubar — safe to remove from exports

## Acceptance Criteria

1. Typography uses only 4 sizes: `text-2xs` (10px), `text-xs` (12px), `text-sm` (14px), `text-base` (16px) — no `text-[Npx]` patterns remain
2. `zoom: 1.1` is removed from `globals.css` body styles
3. `text-2xs` is defined in the tailwind preset as `['0.625rem', { lineHeight: '0.875rem' }]`
4. Dashboard layout is a 2-column grid: `minmax(200px, 240px) 1fr` — no third column
5. Home view shows summary stats (active agents, blocked agents, total commits, total tokens) and blocked agents with Approve/Deny buttons when no workstream is selected
6. Detail view shows 3 tabs (Intent Map, Live Feed, Plans) when a workstream is selected, defaulting to Intent Map
7. ESC key clears workstream selection and returns to home view
8. Workstream cards show traffic light risk indicators (Context, Errors, Stalls) with green/yellow/red thresholds per spec
9. Agent type badges and operator tags are removed from workstream card agent rows
10. RiskPanel is removed from the dashboard page (not imported, not rendered)
11. Bottom panel resize logic and `riskHoldClock` interval are removed from page.tsx
12. Collision severity "critical" vs "warning" render with distinct red vs yellow styling
13. All badges use `text-2xs font-semibold` consistently
14. `ConfidenceBadge` is extracted to its own file in `dashboard-ui`
15. Decide button failures show error feedback (not silently swallowed)
16. Workstream disappearing while selected clears selection to home view

## Files to Create/Modify

### New Files
- `packages/local/src/app/HomeView.tsx` — Aggregate home view: summary stats + blocked agents panel
- `packages/local/src/app/DetailView.tsx` — Tabbed detail view: Intent Map / Live Feed / Plans
- `packages/dashboard-ui/src/components/ConfidenceBadge.tsx` — Extracted from PlanDetail

### Modified Files
- `packages/dashboard-ui/src/tailwind-preset.ts` — Add `text-2xs` to fontSize scale
- `packages/local/src/app/globals.css` — Remove `zoom: 1.1` from body
- `packages/local/src/app/page.tsx` — Replace 3-column grid with 2-column master-detail; remove bottom panel resize logic, `riskHoldClock`, RiskPanel import; add workstream selection state, ESC handler, conditional HomeView/DetailView rendering
- `packages/dashboard-ui/src/components/WorkstreamNode.tsx` — Add traffic light risk indicators; remove agent type badges and operator tags from agent rows; add mini progress bar
- `packages/dashboard-ui/src/components/AgentCard.tsx` — Standardize badge typography
- `packages/dashboard-ui/src/components/PlanDetail.tsx` — Remove ConfidenceBadge (import from new file); remove bottom-panel resize props; accept workstream filter; standardize badge typography
- `packages/dashboard-ui/src/components/CollisionDetail.tsx` — Fix critical vs warning severity styling (red vs yellow)
- `packages/dashboard-ui/src/components/FeedItem.tsx` — Standardize badge typography
- `packages/dashboard-ui/src/components/DeviationItem.tsx` — Standardize badge typography
- `packages/dashboard-ui/src/components/TopBar.tsx` — Standardize badge typography
- `packages/dashboard-ui/src/components/RiskPanel.tsx` — Remove from dashboard-ui index exports (file can remain)
- `packages/dashboard-ui/src/index.ts` — Remove RiskPanel export; add ConfidenceBadge export
- Various component files — Replace arbitrary `text-[Npx]` font sizes with scale tokens

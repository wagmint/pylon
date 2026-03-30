# Plan: 0002-context-recap-panel

## Checkpoint 1: TurnSummary type and server-side builder

**Description**: Define the `TurnSummary` interface in both server and dashboard-ui type files. Implement `buildTurnSummaries()` in the server to convert `TurnNode[]` into `TurnSummary[]` (max 20, within 24h, newest first). Add `recentTurns: TurnSummary[]` to the `Agent` interface in both packages. Re-export from index files.
**Files**: `packages/server/src/types/dashboard.ts`, `packages/server/src/types/index.ts`, `packages/dashboard-ui/src/types.ts`, `packages/server/src/core/turn-summaries.ts`
**Test command**: `cd packages/server && npx tsc --noEmit`
**Acceptance criteria**:
- `TurnSummary` interface exists in both server and dashboard-ui types with all spec fields
- `Agent` interface has `recentTurns: TurnSummary[]` in both packages
- `buildTurnSummaries(turns, limit)` returns at most `limit` summaries, excludes turns > 24h old, sorted newest first
- TypeScript compiles without errors in both packages
**Dependencies**: None

## Checkpoint 2: Wire turn summaries into SSE payload

**Description**: In `dashboard.ts`, call `buildTurnSummaries()` when constructing each `Agent` object and populate `recentTurns`. The TurnNode array for each session is already available in the dashboard builder — pass it through the new function. Ensure the serialized SSE payload includes the new field.
**Files**: `packages/server/src/core/dashboard.ts`
**Test command**: `cd packages/server && npx tsc --noEmit`
**Acceptance criteria**:
- Each agent in the SSE `DashboardState` payload includes `recentTurns`
- Turn summaries are built from the session's parsed `TurnNode[]`
- Server compiles and the SSE payload shape matches `DashboardState`
**Dependencies**: Checkpoint 1

## Checkpoint 3: TurnEntry component

**Description**: Build the `TurnEntry` component in dashboard-ui. Handles collapsed/expanded states, role-based left-border coloring (blue for user, green for assistant), relative timestamp display, truncated preview (~80 chars), and expanded details (file badges, commit badge, error indicator, goal summary for assistant turns).
**Files**: `packages/dashboard-ui/src/components/TurnEntry.tsx`, `packages/dashboard-ui/src/index.ts`
**Test command**: `cd packages/dashboard-ui && npx tsc --noEmit`
**Acceptance criteria**:
- TurnEntry renders collapsed by default with role indicator, relative time, and truncated text
- Click toggles between collapsed and expanded states
- User turns have `border-l-2 border-blue-400` (or equivalent dash theme color)
- Assistant turns have `border-l-2 border-dash-green`
- Expanded assistant turns show file chips, commit message badge, error indicator, goal summary
- Component uses `text-xs` for body text, `text-2xs` minimum per spec NFR
**Dependencies**: Checkpoint 1

## Checkpoint 4: AgentContextCard component

**Description**: Build the `AgentContextCard` component. Renders a sticky header row (status pip + agent label + model + turn count) and a reverse-chronological list of TurnEntry components. Handles empty state ("No activity yet"). New turns use `animate-flash-in`.
**Files**: `packages/dashboard-ui/src/components/AgentContextCard.tsx`, `packages/dashboard-ui/src/index.ts`
**Test command**: `cd packages/dashboard-ui && npx tsc --noEmit`
**Acceptance criteria**:
- Sticky header shows status pip (colored dot matching agent status), agent label, model, turn count
- Turn entries rendered in reverse chronological order (array is already sorted from server)
- Empty state shows "No activity yet" message
- New turns (detected by comparing previous props) get `animate-flash-in` class
- Component accepts `Agent` as its primary prop
**Dependencies**: Checkpoint 3

## Checkpoint 5: ContextRecapPanel component and DetailView integration

**Description**: Build the `ContextRecapPanel` as a scrollable container that renders AgentContextCards sorted by status (busy > blocked > idle), then by most recent turn timestamp. Cards separated by dividers. Integrate into DetailView by replacing the "intent-map" tab with "context-recap". Update tab default, tab type, and tab labels. Agent card reordering uses FLIP animation pattern.
**Files**: `packages/dashboard-ui/src/components/ContextRecapPanel.tsx`, `packages/dashboard-ui/src/index.ts`, `packages/local/src/app/DetailView.tsx`
**Test command**: `cd packages/local && npx tsc --noEmit`
**Acceptance criteria**:
- ContextRecapPanel renders all agents from workstream as AgentContextCards
- Cards sorted: busy first, then blocked, then idle; within each group by most recent turn
- Horizontal divider (`border-dash-border`) separates cards
- Entire panel scrolls as one unit (`overflow-y-auto` on container)
- Agent card headers are sticky (`position: sticky`)
- DetailView tab bar shows "Context Recap" as first tab instead of "Intent Map"
- Default active tab is "context-recap"
- FLIP animation on card reorder when agent status changes
- Loading skeleton shown when SSE data is not yet available
**Dependencies**: Checkpoint 2, Checkpoint 4

## Checkpoint 6: Polish and verification

**Description**: Full TypeScript compilation check across all packages. Verify exports are correct in dashboard-ui index. Ensure no unused imports from removed Intent Map references. Verify the WorkstreamNode component is still importable (it may be used elsewhere even though it's removed from DetailView).
**Files**: `packages/dashboard-ui/src/index.ts`, `packages/local/src/app/DetailView.tsx`
**Test command**: `cd packages/local && npx tsc --noEmit && cd ../../packages/dashboard-ui && npx tsc --noEmit && cd ../../packages/server && npx tsc --noEmit`
**Acceptance criteria**:
- All three packages compile without TypeScript errors
- `ContextRecapPanel`, `AgentContextCard`, `TurnEntry`, and `TurnSummary` are exported from dashboard-ui
- No dead imports in DetailView (WorkstreamNode import removed if no longer used there)
- WorkstreamNode component remains available in dashboard-ui exports (not deleted, just no longer used in DetailView)
**Dependencies**: Checkpoint 5

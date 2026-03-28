# Specification: Dashboard Master-Detail Layout Overhaul

**Status**: review
**Created**: 2026-03-28
**Last Updated**: 2026-03-28

## Overview

Restructure the hexdeck dashboard from a cramped 3-column layout (Workstreams | Intent Map + Feed | Risk Panel) into a 2-column master-detail pattern. The left panel shows workstream cards with embedded risk indicators. The right panel shows either an aggregate home view (when no workstream is selected) or a tabbed detail view (Intent Map / Live Feed / Plans) for the selected workstream. Typography is standardized from 8+ arbitrary sizes to 4 consistent sizes.

## Functional Requirements

### FR1: Typography Scale Standardization
- **Description**: Replace all arbitrary pixel font sizes with a 4-tier type scale and remove the global `zoom: 1.1` hack.
- **Acceptance Criteria**:
  - Given the dashboard is rendered, when inspecting any text element, then its font size class is one of `text-2xs` (10px), `text-xs` (12px), `text-sm` (14px), or `text-base` (16px)
  - Given the `globals.css` file, when reading the body styles, then `zoom: 1.1` is absent
  - Given the tailwind preset, when checking `theme.extend.fontSize`, then `'2xs': ['0.625rem', { lineHeight: '0.875rem' }]` is defined
  - Given any of the 15 component files, when searching for `text-[`, then zero matches are found for pixel-based font sizes
- **Priority**: Must-have

### FR2: Master-Detail Layout
- **Description**: Replace the 3-column CSS grid with a 2-column master-detail layout. Left column: workstream list (~240px). Right column: context-dependent content (1fr).
- **Acceptance Criteria**:
  - Given the dashboard page, when rendered at 1280px viewport width, then the layout uses `gridTemplateColumns: "minmax(200px, 240px) 1fr"`
  - Given no workstream is selected, when viewing the right panel, then the HomeView is displayed with summary stats and blocked agents
  - Given a workstream is selected, when viewing the right panel, then the DetailView is displayed with 3 tabs
  - Given the layout, when inspecting the grid, then there is no third column (RiskPanel column is eliminated)
  - Given the page component, when checking state/effects, then the bottom panel resize logic and `riskHoldClock` 2-second interval are removed
- **Priority**: Must-have

### FR3: Aggregate Home View
- **Description**: When no workstream is selected, the right panel shows high-level summary stats and a blocked agents panel with action buttons.
- **Acceptance Criteria**:
  - Given no workstream is selected, when viewing the home view, then summary stats are displayed: active agent count, blocked agent count, total commits, total tokens (from `DashboardSummary`)
  - Given agents are blocked, when viewing the home view, then each blocked agent is listed with its tool name, description, and Approve/Deny buttons
  - Given the user clicks Approve on a blocked agent, when the API responds successfully, then the agent is removed from the blocked list
  - Given the user clicks Approve on a blocked agent, when the API fails, then feedback is shown (not silently swallowed)
  - Given no agents are blocked, when viewing the home view, then the blocked section shows "No agents waiting for approval"
  - Given no workstreams exist, when viewing the home view, then the existing empty state message is shown ("No sessions detected yet")
- **Priority**: Must-have

### FR4: Tabbed Detail View
- **Description**: When a workstream is selected, the right panel shows 3 tabs: Intent Map, Live Feed, and Plans. Each tab renders full-width content.
- **Acceptance Criteria**:
  - Given a workstream is selected, when viewing the detail view, then a tab bar is shown with "Intent Map", "Live Feed", and "Plans" tabs
  - Given the Intent Map tab is active, when viewing the content, then WorkstreamNode components render at full panel width for the selected workstream only
  - Given the Live Feed tab is active, when viewing the content, then FeedItem components render filtered to the selected workstream
  - Given the Plans tab is active, when viewing the content, then PlanDetail renders for the selected workstream (replaces the old bottom panel)
  - Given the active tab, when inspecting its tab button, then it has a green bottom border (`border-dash-green`) and `text-dash-text` color
  - Given an inactive tab, when inspecting its tab button, then it has `text-dash-text-muted` color and no border
  - Given a workstream is selected, when pressing ESC, then the selection clears and the home view is shown
  - Given the detail view, when the page first loads with a selection, then the default active tab is "Intent Map"
- **Priority**: Must-have

### FR5: Workstream Card Risk Indicators
- **Description**: Each workstream card displays vertical traffic light indicators showing context usage, error rate, and stall signal status with colored dots and labels.
- **Acceptance Criteria**:
  - Given a workstream card, when rendered, then 3 risk rows are shown below the task progress: Context, Errors, Stalls
  - Given an agent with context usage < 60%, when viewing its workstream card, then the Context dot is green
  - Given an agent with context usage >= 60% and < 80%, when viewing its workstream card, then the Context dot is yellow
  - Given an agent with context usage >= 80%, when viewing its workstream card, then the Context dot is red
  - Given an agent with error rate < 5%, when viewing its workstream card, then the Errors dot is green
  - Given an agent with error rate >= 5% and < 15%, when viewing its workstream card, then the Errors dot is yellow
  - Given an agent with error rate >= 15%, when viewing its workstream card, then the Errors dot is red
  - Given an agent with no stall signals, when viewing its workstream card, then the Stalls dot is green and shows "none"
  - Given an agent with 1 stall signal, when viewing its workstream card, then the Stalls dot is yellow
  - Given an agent with 2+ stall signals, when viewing its workstream card, then the Stalls dot is red
  - Given a workstream with multiple agents, when viewing the card, then risk indicators use: `WorkstreamRisk.errorRate` for errors, worst-case `Agent.risk.contextUsagePct` across agents for context, and total `Agent.risk.spinningSignals.length` across agents for stalls
  - Given the workstream card, when rendered, then agent type badges and operator tags are NOT shown in agent rows (removed as redundant)
  - Given a workstream with tasks, when viewing the card, then a mini progress bar is shown under the workstream name
- **Priority**: Must-have

### FR6: RiskPanel Removal
- **Description**: Remove the standalone RiskPanel from the dashboard layout. The component may be retained in the library if used by the menubar app.
- **Acceptance Criteria**:
  - Given the dashboard page, when rendered, then no RiskPanel component is visible
  - Given the page.tsx imports, when inspecting them, then RiskPanel is not imported
  - Given the menubar app, when built, then it still compiles successfully (RiskPanel may still be used there)
- **Priority**: Must-have

### FR7: Collision Severity Bug Fix
- **Description**: Fix the bug where critical and warning collision severities render with identical styling.
- **Acceptance Criteria**:
  - Given a collision with severity "critical", when rendered in CollisionDetail, then it uses `bg-dash-red-dim text-dash-red` styling
  - Given a collision with severity "warning", when rendered in CollisionDetail, then it uses `bg-dash-yellow-dim text-dash-yellow` styling
  - Given both severity levels displayed side by side, when comparing visually, then they are clearly distinguishable (red vs yellow)
- **Priority**: Must-have

### FR8: Badge Style Consistency
- **Description**: Standardize all badge styles across components to use `text-2xs font-semibold`.
- **Acceptance Criteria**:
  - Given any badge element in WorkstreamNode, PlanDetail, DeviationItem, TopBar, or AgentCard, when inspecting its classes, then it uses `text-2xs font-semibold` (not `font-bold`, not `text-[7px]` or `text-[8px]`)
  - Given the PlanDetail component, when inspecting the source, then `ConfidenceBadge` is extracted to a separate file
- **Priority**: Should-have

## Non-Functional Requirements

- **Performance**: Removing the `riskHoldClock` 2-second interval eliminates unnecessary re-renders. The dashboard should not re-render when no SSE data has changed.
- **Readability**: All body text is >= 10px. No text smaller than `text-2xs` (10px) anywhere in the dashboard.
- **Screen support**: Optimized for 1280-1440px laptop viewports. Side panel uses `minmax(200px, 240px)` to adapt.
- **Build compatibility**: All changes must compile in `packages/dashboard-ui`, `packages/local`, and `packages/menubar`.

## API / Interface Contract

No backend API changes. The existing SSE `/api/dashboard/stream` endpoint and `DashboardState` type remain unchanged.

**Component prop changes**:
- `AgentCard` — may need additional `risk` prop (aggregate risk data for the workstream's agents). Verify if `Workstream` type already includes agent risk data via `agents` array.
- `PlanDetail` — no longer needs bottom-panel resize props; receives workstream filter instead.

**New components** (in `packages/local/src/app/`):
- `HomeView` — receives `DashboardState`, renders summary stats + blocked agents
- `DetailView` — receives filtered workstream data, renders 3-tab layout

## Dependencies

- **Requires**: Existing `DashboardState` type with workstream, agent, and risk data
- **Requires**: Existing `DecideButtons` component for blocked agent actions
- **Requires**: Existing `WorkstreamNode`, `FeedItem`, `PlanDetail` components (consumed as tabs)
- **Blocks**: Nothing — this is a UI-only change

## Edge Cases & Error Handling

- **Zero workstreams**: Home view falls through to existing empty state ("No sessions detected yet")
- **All agents idle**: Traffic lights show green across the board; summary stats show "0 Active"
- **Workstream disappears while selected**: If the selected workstream is no longer in state, clear selection and return to home view
- **SSE disconnection**: Existing behavior preserved — `connected` flag in TopBar. No new error handling needed.
- **TopBar stat overlap**: TopBar already shows active agents, collisions, blocked counts. HomeView does NOT duplicate these counters — it focuses on the actionable blocked agents panel with approve/deny buttons. The summary stats line in HomeView shows complementary info: total commits + total tokens.
- **Decide button failure**: Currently silently fails (FR3 requires showing feedback). Show brief error state on the button.
- **Single agent workstream**: Traffic lights reflect that single agent's risk directly (no aggregation needed)
- **Tab state persistence**: Tab selection resets to "Intent Map" when switching between workstreams. This is intentional — each workstream starts at the overview.

## Out of Scope

- Mobile or tablet responsive design (below 1280px)
- Dark/light theme toggle
- Backend API changes
- State management refactoring (React patterns stay as-is)
- Accessibility overhaul (ARIA, contrast, reduced-motion — separate spec)
- New data fetching patterns or caching
- Menubar app layout changes (it uses some shared components but has its own layout)

## Open Issues

- [x] ~~Verify whether `Workstream` type already includes agent risk data~~ — **Resolved**: `Workstream.agents[].risk` has full `AgentRisk` data; `Workstream.risk` has aggregate `WorkstreamRisk`. No new props needed.
- [x] ~~Determine if RiskPanel is used by menubar app~~ — **Resolved**: Not used. Safe to remove from library exports.
- [x] ~~Decide whether ConfidenceBadge extraction belongs in `dashboard-ui`~~ — **Resolved**: Yes, keep in `dashboard-ui` since PlanDetail lives there.

# Task: Context Recap Panel

**Spec**: .cplus/specs/0002-context-recap-panel.md
**Task ID**: 0002-context-recap-panel
**Created**: 2026-03-29

## Goal

Replace the Intent Map tab in the detail view with a Context Recap panel that displays a reverse-chronological feed of user prompts and major assistant responses for each agent in a workstream. This requires extending the server's SSE payload to include turn summaries per agent, adding a new `TurnSummary` type, building new UI components (ContextRecapPanel, AgentContextCard, TurnEntry), and wiring them into the existing master-detail layout from spec 0001.

## Non-Goals

- Full raw conversation viewer or transcript
- Displaying thinking/reasoning blocks or tool call details
- Editing or replaying prompts from the dashboard
- Search or filtering within the context timeline
- Virtualized list for turn entries (spec says limit to 20 entries, which is small enough for direct DOM rendering)

## Constraints

- No new JSONL parsing — all data comes from existing `TurnNode` fields
- SSE payload addition must stay lightweight: max 20 turns per agent, each < 1KB
- Turns older than 24h are excluded server-side
- Must reuse existing animation patterns (flash-in, FLIP) and tailwind preset colors
- Must follow the existing type mirroring pattern: server `types/dashboard.ts` defines authoritative types, `dashboard-ui/src/types.ts` mirrors them for the frontend
- Tab reset behavior in DetailView must change default from "intent-map" to "context-recap"

## Acceptance Criteria

1. The detail view tab bar shows "Context Recap" as the first tab (replacing "Intent Map")
2. The `Agent` interface includes a `recentTurns: TurnSummary[]` field in both server and dashboard-ui types
3. The `TurnSummary` interface matches the spec's API contract (id, timestamp, role, userInstruction, assistantPreview, goalSummary, actionSummary, filesChanged, hasCommit, commitMessage, hasError, model, tokenUsage)
4. The server builds turn summaries from `TurnNode[]` via a `buildTurnSummaries()` function, limited to 20 turns within 24h, newest first
5. SSE payload includes `recentTurns` per agent
6. Context Recap panel shows one AgentContextCard per agent, sorted by status (busy > blocked > idle), then by most recent turn
7. Each AgentContextCard has a sticky header with status pip, agent label, model, and turn count
8. Turn entries show relative timestamps, role indicators, and truncated previews (~80 chars) that expand/collapse on click
9. User turns have a blue left border; assistant turns have a green left border
10. Expanded assistant turns show file badges, commit badge, error indicator, and goal summary
11. Empty state shows "No activity yet" with agent start time
12. Loading state shows a skeleton (not a spinner)
13. New turns animate in with the existing `flash-in` animation
14. Agent cards reorder with smooth animation (FLIP pattern) when status changes
15. Cards are separated by horizontal dividers using `border-dash-border`

## Files to Create/Modify

### Create
- `packages/dashboard-ui/src/components/ContextRecapPanel.tsx` — Main panel component: scrollable container, agent card sorting/layout, dividers
- `packages/dashboard-ui/src/components/AgentContextCard.tsx` — Per-agent card: sticky header, turn timeline, empty state
- `packages/dashboard-ui/src/components/TurnEntry.tsx` — Individual turn entry: expand/collapse, role styling, file/commit badges
- `packages/server/src/core/turn-summaries.ts` — `buildTurnSummaries()` function: TurnNode[] → TurnSummary[]

### Modify
- `packages/dashboard-ui/src/types.ts` — Add `TurnSummary` interface, add `recentTurns` to `Agent`
- `packages/server/src/types/dashboard.ts` — Add `TurnSummary` interface, add `recentTurns` to `Agent`
- `packages/server/src/types/index.ts` — Re-export `TurnSummary`
- `packages/server/src/core/dashboard.ts` — Call `buildTurnSummaries()` when building agent state, include in SSE payload
- `packages/dashboard-ui/src/index.ts` — Export new components and `TurnSummary` type
- `packages/local/src/app/DetailView.tsx` — Replace "intent-map" tab with "context-recap", render ContextRecapPanel, update default tab

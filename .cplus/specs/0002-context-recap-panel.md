# Specification: Context Recap Panel

**Status**: draft
**Created**: 2026-03-28
**Last Updated**: 2026-03-28

## Overview

Replace the Intent Map tab with a **Context Recap** panel that shows the actual conversation context for each agent — user prompts and major Claude responses in a reverse-chronological feed. This gives users an at-a-glance recap of what each agent has been told and what it's doing, without needing to open the actual Claude Code session.

## Naming

| Option | Pros | Cons |
|--------|------|------|
| **Context Recap** | Clear meaning — "recap what's happening". Distinguishes from raw context window. | Two words |
| **Session Log** | Familiar concept | Sounds like raw logs, not curated |
| **Agent Context** | Descriptive | Ambiguous — could mean token context |
| **Recap** | Short, action-oriented | Might be too vague standalone |

**Note: "Context Recap"** — communicates that this is a curated summary of what's been happening, not raw data.

## Data Source

All data already exists in the server's `TurnNode` structure (parsed from JSONL session logs):

| Field | Source | Description |
|-------|--------|-------------|
| `userInstruction` | `TurnNode.userInstruction` | Full user prompt (up to 500 chars) |
| `assistantPreview` | `TurnNode.assistantPreview` | First ~200 chars of Claude's response |
| `sections.goal.summary` | `TurnNode.sections.goal` | Extracted goal from user prompt |
| `sections.actions.summary` | `TurnNode.sections.actions` | What Claude did (edits, commands) |
| `sections.decisions.summary` | `TurnNode.sections.decisions` | Key decisions made |
| `filesChanged` | `TurnNode.filesChanged` | Files modified in this turn |
| `hasCommit` / `commitMessage` | `TurnNode` | Whether a commit was made |
| `hasError` | `TurnNode` | Whether errors occurred |
| `timestamp` | `TurnNode.timestamp` | When the turn happened |
| `model` | `TurnNode.model` | Which model was used |
| `tokenUsage` | `TurnNode.tokenUsage` | Tokens consumed |

**No new parsing needed.** The server already extracts all of this from Claude Code / Codex JSONL files.

### What needs to ship to the dashboard

Currently `TurnNode` data lives on the server and feeds into `FeedEvent` and `Agent` state. The turn-level conversation data (user prompts, assistant responses) is **not currently sent to the dashboard via SSE**. We need to:

1. Add a `turns` field to the `Agent` type in the dashboard state
2. Have the server include recent turns per agent in the SSE payload
3. Keep it lightweight — send summaries, not full raw events

## Functional Requirements

### FR1: Context Recap Tab
- **Description**: Replace the "Intent Map" tab with "Context Recap" in the detail view tab bar.
- **Acceptance Criteria**:
  - Given a workstream is selected, when viewing the tab bar, then the first tab reads "Context Recap" (not "Intent Map")
  - Given the Context Recap tab is active, when viewing the content, then agent context cards are displayed for each agent in the selected workstream
- **Priority**: Must-have

### FR2: Agent Context Card
- **Description**: Each agent within the selected workstream gets its own context card showing user prompts and major responses in reverse chronological order.
- **Acceptance Criteria**:
  - Given the Context Recap tab is active, when viewing the panel, then each agent has a distinct card with a header showing agent label and status
  - Given an agent context card, when viewing entries, then each entry shows either a user prompt or a major assistant response
  - Given an agent context card, when viewing the timeline, then entries are in reverse chronological order (newest at top)
  - Given an entry is a user prompt, when viewing it, then it is visually distinct from assistant responses (different background color or left-border accent)
  - Given an entry is an assistant response, when viewing it, then it shows the action summary (files changed, commits, decisions) not raw text
- **Priority**: Must-have

### FR3: Multi-Agent Layout
- **Description**: All agent context cards are displayed in a single vertical scrollable stack. Active agents are pinned to the top. Each card is separated by a visible divider.
- **Acceptance Criteria**:
  - Given a workstream with multiple agents, when viewing the Context Recap, then all agent cards are visible in a single scrollable column (no accordion, no independent card scrolling)
  - Given 3 agents (1 busy, 1 blocked, 1 idle), when viewing the Context Recap, then the busy agent's card appears first, blocked second, idle third
  - Given an agent transitions from idle to busy, when the next SSE update arrives, then the card moves to the top of the list with smooth animation (reuse existing FLIP pattern)
  - Given the panel has more content than viewport height, when the user scrolls, then the entire panel scrolls as one unit
  - Given each agent card, when viewing it, then it has a sticky header row (agent label + status pip + model + turn count) that remains visible while scrolling through that card's turns
  - Given 5+ agents in a workstream, when viewing the panel, then the layout remains the same — vertical stack, active pinned to top, panel scrolls
  - Given agent cards are separated, when viewing the panel, then a horizontal divider (`border-dash-border`) separates each card
- **Priority**: Must-have

### FR4: Turn Entry Layout
- **Description**: Each turn entry in the reverse-timeline shows the user instruction and the key outcome.
- **Acceptance Criteria**:
  - Given a turn entry, when viewing it, then it shows:
    - Timestamp (relative, e.g. "2m ago")
    - Role indicator: "You" for user prompts, agent label for assistant
    - Content: user instruction text (for user turns) or action summary (for assistant turns)
  - Given a user turn entry, when viewing it in collapsed state (default), then it shows a single-line preview truncated to ~80 chars with ellipsis
  - Given a user turn entry, when the user clicks on it, then it expands to show the full `userInstruction` text (up to 500 chars)
  - Given an expanded turn entry, when the user clicks on it again, then it collapses back to the single-line preview
  - Given an assistant turn entry, when viewing it in collapsed state (default), then it shows a one-line action summary (from `sections.actions.summary` or `assistantPreview`, truncated to ~80 chars)
  - Given an assistant turn entry, when the user clicks on it, then it expands to show:
    - Full action summary line
    - File badges: list of `filesChanged` as small chips
    - Commit badge if `hasCommit` (shows commit message)
    - Error indicator if `hasError`
    - Goal summary if available
  - Given the turn entry, when viewing the timestamp, then it shows relative time (e.g. "2m ago", "1h ago")
- **Priority**: Must-have

### FR5: Dashboard State Extension
- **Description**: Extend the SSE `DashboardState` payload to include recent turn data per agent.
- **Acceptance Criteria**:
  - Given the `Agent` interface, when checking its fields, then it includes a `recentTurns` array of turn summaries
  - Given the turn summary type, when checking its fields, then it includes: `id`, `timestamp`, `userInstruction`, `assistantPreview`, `goalSummary`, `actionSummary`, `filesChanged`, `hasCommit`, `commitMessage`, `hasError`, `tokenUsage`, `model`
  - Given the SSE payload, when measuring its size, then each agent includes at most 20 recent turns (to keep payload lightweight)
  - Given a turn older than 24 hours, when building the payload, then it is excluded from `recentTurns`
- **Priority**: Must-have

### FR6: Empty and Loading States
- **Description**: Handle cases where an agent has no turns yet or data is still loading.
- **Acceptance Criteria**:
  - Given an agent with zero turns, when viewing its context card, then it shows "No activity yet" with the agent's start time
  - Given the SSE connection is loading, when viewing the Context Recap, then a subtle loading skeleton is shown (not a spinner)
- **Priority**: Should-have

## Non-Functional Requirements

- **Payload size**: Each `recentTurn` summary should be < 1KB. With 20 turns x 5 agents = ~100KB max addition to SSE payload per tick. This is acceptable at 1s intervals.
- **Render performance**: Reverse-timeline should use virtualization or limit to 20 visible entries to avoid DOM bloat.
- **Readability**: All text in context cards uses the standardized font scale (`text-2xs` minimum, `text-xs` for body text).

## API / Interface Contract

### New Type: `TurnSummary`

```typescript
export interface TurnSummary {
  id: string;                    // Unique turn ID
  timestamp: string;             // ISO 8601
  role: "user" | "assistant";    // Who initiated this turn
  userInstruction: string;       // What the user said (up to 500 chars)
  assistantPreview: string;      // First ~200 chars of response
  goalSummary: string | null;    // Extracted goal (from sections.goal.summary)
  actionSummary: string | null;  // What was done (from sections.actions.summary)
  filesChanged: string[];        // Files modified
  hasCommit: boolean;
  commitMessage: string | null;
  hasError: boolean;
  model: string | null;
  tokenUsage: { input: number; output: number } | null;
}
```

### Agent Type Extension

```typescript
export interface Agent {
  // ... existing fields ...
  recentTurns: TurnSummary[];   // Last 20 turns, newest first
}
```

### Server-side: Turn Summary Builder

Location: `packages/server/src/core/` — new function to map `TurnNode[]` → `TurnSummary[]`

```typescript
function buildTurnSummaries(turns: TurnNode[], limit: number = 20): TurnSummary[]
```

## Dependencies

- **Requires**: Existing `TurnNode` parsing in `packages/server/src/core/nodes.ts`
- **Requires**: Context Recap tab replaces Intent Map in the master-detail layout (spec 0001)
- **Requires**: `Agent` type in `packages/dashboard-ui/src/types.ts`
- **Blocks**: Nothing

## Component Structure

```
Context Recap Tab
├── ContextRecapPanel (scrollable container, overflow-y-auto)
│   │
│   ├── AgentContextCard (agent-1, active — pinned to top)
│   │   ├── Sticky Header: 🟢 pip + "agent-1" + model + "12 turns"
│   │   └── Turn Timeline (reverse chronological, all visible)
│   │       ├── TurnEntry (user, collapsed by default)
│   │       │   └── "You · 2m ago" + truncated preview (~80 chars)
│   │       │       └── [on click] → expands to full instruction
│   │       └── TurnEntry (assistant, collapsed by default)
│   │           └── "agent-1 · 1m ago" + truncated action summary
│   │               └── [on click] → expands: full summary + file badges + commit
│   │
│   ├── ── divider (border-dash-border) ──
│   │
│   ├── AgentContextCard (agent-2, blocked)
│   │   ├── Sticky Header: 🟡 pip + "agent-2" + model + "5 turns"
│   │   └── Turn Timeline (same structure)
│   │
│   ├── ── divider ──
│   │
│   └── AgentContextCard (agent-3, idle)
│       ├── Sticky Header: ⚪ pip + "agent-3" + model + "3 turns"
│       └── Turn Timeline (same structure)
```

**Scrolling behavior**: The entire panel scrolls as one unit. Each agent card header is `position: sticky` so it stays visible while scrolling through that agent's turns. When the user scrolls past an agent's turns into the next agent, the previous sticky header is replaced by the next one.

**Sort order**: Active (busy) → Blocked → Idle. Within each status group, sort by most recent turn timestamp (newest activity first).

## Visual Design

### User Turn Entry — Collapsed (default)
```
┌─ blue left border ──────────────────────────┐
│ You · 2m ago                                 │
│ "Refactor the auth middleware to use JWT…"    │
└──────────────────────────────────────────────┘
```

### User Turn Entry — Expanded (on click)
```
┌─ blue left border ──────────────────────────┐
│ You · 2m ago                                 │
│ "Refactor the auth middleware to use JWT      │
│  tokens instead of session cookies. Make      │
│  sure to update the tests and add proper      │
│  error handling for expired tokens."          │
└──────────────────────────────────────────────┘
```

### Assistant Turn Entry — Collapsed (default)
```
┌─ green left border ─────────────────────────┐
│ agent-1 · 1m ago                             │
│ Updated auth middleware with JWT flow…        │
└──────────────────────────────────────────────┘
```

### Assistant Turn Entry — Expanded (on click)
```
┌─ green left border ─────────────────────────┐
│ agent-1 · 1m ago                     gpt-4o │
│ Updated auth middleware with JWT flow         │
│ [auth.ts] [middleware.ts] [+2 files]         │
│ ● committed: "refactor auth to JWT"          │
│ Goal: Replace session cookies with JWT        │
└──────────────────────────────────────────────┘
```

### Full Panel Layout (multiple agents)
```
┌─────────────────────────────────────────────┐
│ 🟢 agent-1 · claude-sonnet · 12 turns      │ ← sticky header
├─────────────────────────────────────────────┤
│ ┃ You · 2m ago                              │
│ ┃ "Refactor the auth middleware to use…"    │
│                                             │
│ ┃ agent-1 · 1m ago                          │
│ ┃ Updated auth middleware with JWT flow…    │
│                                             │
│ ┃ You · 8m ago                              │
│ ┃ "Add rate limiting to the API…"           │
├─────────────── divider ─────────────────────┤
│ 🟡 agent-2 · codex · 5 turns               │ ← sticky header
├─────────────────────────────────────────────┤
│ ┃ You · 5m ago                              │
│ ┃ "Add logging to the pipeline…"            │
│                                             │
│ ┃ agent-2 · 4m ago                          │
│ ┃ Added structured logging to pipeline…     │
├─────────────── divider ─────────────────────┤
│ ⚪ agent-3 · claude-sonnet · 3 turns        │ ← sticky header
├─────────────────────────────────────────────┤
│ ┃ You · 20m ago                             │
│ ┃ "Fix the failing test in auth…"           │
└─────────────────────────────────────────────┘
         ↕ entire panel scrolls as one unit
```

## Edge Cases & Error Handling

- **Agent with 0 turns**: Show "No activity yet — session started {time ago}"
- **Very long user instruction**: Collapsed by default (~80 chars). Click to expand full text, click again to collapse.
- **Many agents (5+)**: Cards are scrollable within the panel. Active agents stay at top.
- **Rapid SSE updates**: New turns should flash-in (reuse existing `flash-in` animation) at the top of the timeline
- **Agent disappears mid-view**: Remove card with fade-out; if it was the only agent, show empty state
- **Stale turn data**: Turns older than 24h are excluded server-side; client doesn't need to filter

## Out of Scope

- Full raw conversation viewer (this is a recap, not a transcript)
- Thinking/reasoning block display
- Tool call detail expansion
- Editing or replaying prompts from the dashboard
- Search or filtering within the context timeline

## Open Issues

- [ ] Decide the exact max character count for `assistantPreview` in turn summaries (currently 200 — is that enough for a useful recap?)
- [ ] Should the Context Recap show turns from ALL agents interleaved in one timeline, or separate cards per agent? (Spec assumes separate cards — but interleaved view could show cross-agent activity order)
- [ ] Determine if `WorkstreamNode` component can be retired or if it's still needed for other views after Intent Map is removed

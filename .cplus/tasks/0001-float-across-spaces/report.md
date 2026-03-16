# Report: Float Across Spaces Toggle

**Status**: COMPLETE — PASS

## Summary
Added a "Float Across Spaces" toggle to the menubar popup. When enabled, both the widget and popup windows become visible across all macOS Spaces. State persists to `~/.hexdeck/menubar-settings.json` and is applied on startup.

## Changes

### `packages/menubar/src-tauri/src/lib.rs`
- Added `#[serde(default)] float_across_spaces: bool` to `WidgetSettings`
- Updated `load_settings()` default to include `float_across_spaces: false`
- Added `apply_float_across_spaces(app, enabled)` — calls `set_visible_on_all_workspaces` on `widget` + `main` windows; gated with `#[cfg(target_os = "macos")]`
- Added `load_float_across_spaces()` Tauri command
- Added `save_float_across_spaces(app, enabled)` Tauri command — saves settings then applies immediately
- Both commands registered in `invoke_handler`
- Startup call to `apply_float_across_spaces` added in `setup` (macOS-only)

### `packages/menubar/src/components/MenuBarApp.tsx`
- Added `useState<boolean>` for `floatAcrossSpaces` (init `false`)
- Added `useEffect` to invoke `load_float_across_spaces` on mount
- Added pill-style toggle row in footer above "Open Dashboard" button

## Verification
- `cargo check` — PASS
- `npm run vite:build` — PASS
- `npx tsc --noEmit` — PASS
- `npm run test` (server) — 7/7 PASS

## Decisions
- **macOS gate**: `apply_float_across_spaces` and its startup call are `#[cfg(target_os = "macos")]`. On non-macOS the feature is silently a no-op — consistent with spec.
- **Optimistic UI update**: Frontend sets state before invoke completes. Matches existing patterns; invoke failure here is not a user-recoverable scenario.
- **No `app` param on `load_float_across_spaces`**: Consistent with existing load commands (`load_has_seen_tooltip`, etc.) that only read settings.

## Risks
- None identified. `set_visible_on_all_workspaces` is stable Tauri 2 API. No new dependencies added.

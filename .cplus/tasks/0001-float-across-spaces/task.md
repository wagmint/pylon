# Task: Float Across Spaces Toggle

**Spec**: `.cplus/specs/0001-float-across-spaces.md`
**Status**: in-progress

## Goal
Add a toggle in the menubar popup that controls whether the app's windows float across all macOS Spaces or stay pinned to one.

## Non-Goals
- Tray context menu toggle
- Per-window granularity
- Onboarding UI

## Constraints
- macOS-only: `set_visible_on_all_workspaces` is macOS-specific; gate with `#[cfg(target_os = "macos")]`
- No new dependencies
- Follow existing `load_settings` / `save_settings` pattern
- Toggle visually consistent with existing popup footer

## Acceptance Criteria
- [ ] Toggle visible in popup footer
- [ ] ON → widget + main windows appear on all Spaces
- [ ] OFF → windows revert to current Space only
- [ ] State persisted to `~/.hexdeck/menubar-settings.json`
- [ ] Applied on app startup
- [ ] Missing key in settings defaults to OFF

## Commands
```bash
cd packages/menubar
npm run vite:build       # TypeScript build check
cargo check              # Rust check (from src-tauri/)
```

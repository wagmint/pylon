# Specification: Float Across Spaces Toggle

**Status**: approved
**Created**: 2026-03-16
**Last Updated**: 2026-03-16

## Overview

Add a toggle inside the menubar popup window that controls whether the app's windows (floating widget and popup) are pinned to a single macOS Space or float across all Spaces. When enabled, users can switch Spaces and still see the floating widget and open the popup from any Space.

## Functional Requirements

### FR1: Float Across Spaces Toggle in Popup

- **Description**: A toggle control rendered inside the popup window (MenuBarApp) that turns "Float Across Spaces" on or off.
- **Acceptance Criteria**:
  - Given the popup is open, when the user views it, then a labeled toggle for "Float Across Spaces" is visible.
  - Given the toggle is OFF, when the user enables it, then the widget and popup windows immediately become visible on all Spaces.
  - Given the toggle is ON, when the user disables it, then the widget and popup windows revert to being pinned to the current Space.
- **Priority**: Must-have

### FR2: Apply to All Windows

- **Description**: When float is ON, both the floating widget window and the popup window float across all Spaces.
- **Acceptance Criteria**:
  - Given float is ON, when the user switches to any Space, then the floating widget remains visible.
  - Given float is ON, when the user clicks the tray icon from any Space, then the popup opens on that Space.
  - Given float is OFF (default), when the user switches Spaces, then the widget and popup are not visible (current behavior preserved).
- **Priority**: Must-have

### FR3: Persist Toggle State

- **Description**: The toggle state is saved to `~/.hexdeck/menubar-settings.json` and restored on app restart.
- **Acceptance Criteria**:
  - Given the user enables float, when the app restarts, then float is still ON and windows are visible on all Spaces.
  - Given `menubar-settings.json` has no `float_across_spaces` key (older install), then the app defaults to OFF.
- **Priority**: Must-have

### FR4: Apply on Startup

- **Description**: On launch, the saved `float_across_spaces` value is applied to all windows immediately.
- **Acceptance Criteria**:
  - Given float was ON before quit, when the app starts, then windows are set to visible on all Spaces before the user interacts.
- **Priority**: Must-have

## Non-Functional Requirements

- The toggle must be visually consistent with other controls in the popup window.
- No additional dependencies required; uses Tauri's built-in `set_visible_on_all_workspaces` window API (macOS).
- Settings read/write follows the existing `load_settings` / `save_settings` pattern in `lib.rs`.

## API / Interface Contract

### Backend (Rust — `lib.rs`)

**Settings struct addition:**
```rust
struct WidgetSettings {
    // ... existing fields ...
    #[serde(default)]
    float_across_spaces: bool,
}
```

**New Tauri commands:**
```rust
#[tauri::command]
fn load_float_across_spaces(app: AppHandle) -> bool

#[tauri::command]
fn save_float_across_spaces(app: AppHandle, enabled: bool) -> Result<(), String>
```

**New helper:**
```rust
fn apply_float_across_spaces(app: &tauri::AppHandle, enabled: bool) {
    // Calls set_visible_on_all_workspaces(enabled) on "widget" and "main" windows
    // macOS-only; no-op on other platforms
}
```

### Frontend (TypeScript — `MenuBarApp.tsx`)

- Invoke `load_float_across_spaces` on mount to read initial state.
- Render a toggle control bound to the loaded state.
- On toggle change: invoke `save_float_across_spaces(enabled)` — the backend applies the change to both windows immediately.

## Dependencies

- Requires: Tauri 2 `WebviewWindow::set_visible_on_all_workspaces` (already available in current Tauri 2 version)
- Blocks: nothing

## Edge Cases & Error Handling

- **Old settings file**: `float_across_spaces` key absent → `#[serde(default)]` returns `false` (OFF). No migration needed.
- **Popup auto-hide behavior**: `set_visible_on_all_workspaces` only controls which Space the window can appear on. The existing focus-loss auto-hide logic for the popup is unaffected.
- **Tray icon**: The macOS tray/menu bar is always visible on all Spaces by default; no change needed for the tray itself.
- **Platform**: `set_visible_on_all_workspaces` is macOS-only. The `apply_float_across_spaces` helper should be gated with `#[cfg(target_os = "macos")]`.

## Out of Scope

- Adding this toggle to the right-click tray context menu.
- Changing auto-hide behavior of the popup when float is ON.
- Per-window granularity (widget vs popup separately).
- Any UI for this in the onboarding flow.

## Open Issues

- None

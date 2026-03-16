# Plan: Float Across Spaces Toggle

## Checkpoint 1: Backend — WidgetSettings + commands + startup apply
**Files**: `packages/menubar/src-tauri/src/lib.rs`

Changes:
1. Add `#[serde(default)] float_across_spaces: bool` to `WidgetSettings`
2. Update `load_settings()` defaults to include `float_across_spaces: false`
3. Add `apply_float_across_spaces(app: &tauri::AppHandle, enabled: bool)` — macOS-only
4. Add `load_float_across_spaces(app: AppHandle) -> bool` Tauri command
5. Add `save_float_across_spaces(app: AppHandle, enabled: bool) -> Result<(), String>` — saves + applies
6. Register both commands in `invoke_handler`
7. In `setup`, call `apply_float_across_spaces` with loaded setting (after widget visibility apply)

Exit: `cargo check` passes in `src-tauri/`

## Checkpoint 2: Frontend — toggle UI in MenuBarApp
**Files**: `packages/menubar/src/components/MenuBarApp.tsx`

Changes:
1. Add `useState<boolean>` for `floatAcrossSpaces`, init `false`
2. Add `useEffect` to invoke `load_float_across_spaces` on mount
3. Add toggle row in footer (above or alongside "Open Dashboard" button)
4. On toggle: invoke `save_float_across_spaces({ enabled: !floatAcrossSpaces })` + update state

Exit: `npm run vite:build` passes in `packages/menubar/`

# Hexdeck

Monorepo for Hexdeck — a monitoring dashboard and floating widget for Claude Code sessions.

## Packages

- `packages/server` — Core server (Hono + Node.js). Session discovery, dashboard state, hooks, SSE. **Has its own CLAUDE.md with critical edge cases — read it before modifying status/hook logic.**
- `packages/menubar` — Tauri v2 + React floating widget (macOS). Favicon severity, alerts, approve/deny UI.
- `packages/dashboard-ui` — Shared React components for agent cards, feed items, etc.
- `packages/local` — Next.js full dashboard (localhost:7433).
- `packages/cli` — CLI tool for Hexdeck.

## Build

- Server: `cd packages/server && bun run build`
- Menubar: `cd packages/menubar && bun run build` (requires Rust/Tauri)
- Dashboard UI: `cd packages/dashboard-ui && bun run build`
- Type check: `npx tsc --noEmit` in each package

## Release

Menubar releases are triggered by git tags matching `menubar-v*`. This triggers `.github/workflows/release-menubar.yml` which builds macOS arm64/x86_64, codesigns, creates a GitHub Release, and updates the Homebrew tap.

```
# Bump version in 3 files:
# packages/menubar/package.json
# packages/menubar/src-tauri/tauri.conf.json
# packages/menubar/src-tauri/Cargo.toml
git tag menubar-vX.Y.Z && git push origin menubar-vX.Y.Z
```

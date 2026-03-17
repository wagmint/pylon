# Contributing to Hexdeck

Thanks for your interest in contributing to Hexdeck!

## Development Setup

```bash
git clone https://github.com/wagmint/hexdeck.git
cd hexdeck
npm install
```

### Running in development

```bash
npm run dev           # Runs Next.js dashboard (:3000) + API server (:7433)
npm run dev:server    # API server only
npm run dev:local     # Dashboard only
```

### Building

```bash
npm run build         # Builds all packages in order
```

Build order: `dashboard-ui` → `local` (Next.js) → `server` (tsc) → `cli` (tsup + copy dashboard)

### Project Structure

```
packages/
├── dashboard-ui/   # Shared React component library
├── local/          # Next.js dashboard (static export)
├── server/         # Hono API server + session parsing
└── cli/            # CLI tool (bundles server + dashboard)
```

## Menubar development

The `packages/menubar` package is a [Tauri](https://tauri.app/) app (Rust + React). It has additional requirements beyond the TypeScript packages.

### Prerequisites

**Rust** (for the Tauri backend):
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

**Bun** (to compile the standalone server binary):
```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bun/env
```

### Staging resources

Before running `cargo check` or `npm run dev` in `packages/menubar`, the Tauri build system requires two pre-built artifacts staged into `src-tauri/`:
- `binaries/hexdeck-server` — the standalone server binary
- `dashboard/` — the Next.js static export

Run this once (and again after changes to `packages/server` or `packages/local`):

```bash
make prepare-menubar
```

### Running in development

```bash
cd packages/menubar
npm run dev   # starts Vite + Tauri dev window
```

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run build` to verify everything compiles
4. Open a pull request with a clear description of what changed and why

## Reporting Issues

- Use the [bug report template](https://github.com/wagmint/hexdeck/issues/new?template=bug_report.md) for bugs
- Use the [feature request template](https://github.com/wagmint/hexdeck/issues/new?template=feature_request.md) for ideas

## Code Style

- TypeScript throughout
- No lint config currently enforced — just match existing patterns
- Prefer small, focused PRs over large changes

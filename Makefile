# Variables
NPM = npm
NPX = npx
API_PORT = 7433
FRONTEND_PORT = 3000
LEVEL ?= patch
HEXDECK_DIR = $(HOME)/.hexdeck
PID_FILE = $(HEXDECK_DIR)/server.pid
STATE_LOCK = $(HEXDECK_DIR)/state.lock

# Default target
.PHONY: help
help:
	@echo "Available commands:"
	@echo "  make hexdeck          - Start Hexdeck (API + dashboard) in foreground"
	@echo "  make start            - Start Hexdeck server in background"
	@echo "  make stop             - Stop Hexdeck server"
	@echo "  make restart          - Restart Hexdeck server"
	@echo "  make reset            - Kill owner, clear stale state files, then start"
	@echo "  make status           - Show Hexdeck server status"
	@echo "  make install          - Install all dependencies"
	@echo "  make build            - Build all packages"
	@echo "  make prepare-menubar  - Stage resources for menubar Tauri build/dev"
	@echo "  make dev-server       - Start server in dev mode (hot-reload)"
	@echo "  make dev-clean        - Quit menubar, clear server owner, then run npm dev"
	@echo "  make dev-menubar      - Build debug .app bundle (registers deep links)"
	@echo "  make open-menubar     - Launch the debug .app"
	@echo "  make test-deeplink    - Test hexdeck:// deep link"
	@echo "  make dashboard-version [LEVEL=patch|minor|major] - Bump @hexdeck/dashboard-ui version"
	@echo "  make cli-version [LEVEL=patch|minor|major]       - Bump @hexdeck/cli version"
	@echo "  make checkpoint NOTE='my note' - Create a checkpoint"
	@echo "  make rewind ID='abc123'       - Rewind to a checkpoint"
	@echo "  make checkpoints              - List all checkpoints"
	@echo "  make parse          - Run CLI parser (usage: make parse ARGS='projects')"
	@echo "  make build-ui       - Build dashboard-ui package"
	@echo "  make typecheck      - Run TypeScript type checking"
	@echo "  make clean          - Remove build artifacts and node_modules"

# Hexdeck (API + dashboard)
.PHONY: hexdeck
hexdeck:
	cd packages/cli && $(NPX) tsx src/index.ts start --foreground

.PHONY: start
start:
	cd packages/cli && $(NPX) tsx src/index.ts start

.PHONY: stop
stop:
	cd packages/cli && $(NPX) tsx src/index.ts stop

.PHONY: restart
restart:
	cd packages/cli && $(NPX) tsx src/index.ts restart

.PHONY: reset
reset:
	@mkdir -p "$(HEXDECK_DIR)"
	@if [ -f "$(PID_FILE)" ]; then \
		pid=$$(python3 - <<'PY' "$(PID_FILE)"; \
import json, sys; \
path = sys.argv[1]; \
try: \
    with open(path, "r", encoding="utf-8") as f: \
        data = json.load(f); \
    pid = data.get("pid"); \
    if isinstance(pid, int): \
        print(pid); \
except Exception: \
    pass; \
PY \
); \
		if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping existing Hexdeck owner PID $$pid"; \
			kill "$$pid" 2>/dev/null || true; \
			sleep 1; \
			if kill -0 "$$pid" 2>/dev/null; then \
				echo "Force killing Hexdeck owner PID $$pid"; \
				kill -9 "$$pid" 2>/dev/null || true; \
			fi; \
		fi; \
	fi
	@rm -f "$(PID_FILE)" "$(STATE_LOCK)"
	@$(MAKE) start

.PHONY: status
status:
	cd packages/cli && $(NPX) tsx src/index.ts status

# Checkpoints
.PHONY: checkpoint
checkpoint:
	cd packages/server && $(NPX) tsx src/cli/index.ts checkpoint $(NOTE)

.PHONY: rewind
rewind:
	cd packages/server && $(NPX) tsx src/cli/index.ts rewind $(ID)

.PHONY: checkpoints
checkpoints:
	cd packages/server && $(NPX) tsx src/cli/index.ts checkpoints

# CLI
.PHONY: parse
parse:
	cd packages/server && $(NPX) tsx src/cli/parse.ts $(ARGS)

# Menubar (Tauri) dev setup
.PHONY: prepare-menubar
prepare-menubar:
	@echo "→ Checking dependencies..."
	@command -v bun >/dev/null 2>&1 || { \
		echo ""; \
		echo "  ✗ bun not found. Install it first:"; \
		echo "    curl -fsSL https://bun.sh/install | bash"; \
		echo ""; \
		exit 1; \
	}
	@command -v cargo >/dev/null 2>&1 || { \
		echo ""; \
		echo "  ✗ cargo not found. Install Rust first:"; \
		echo "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"; \
		echo "    then: source ~/.cargo/env"; \
		echo ""; \
		exit 1; \
	}
	@echo "→ Building server binary..."
	@cd packages/server && bun build src/standalone.ts --compile --target=bun-darwin-arm64 --outfile dist/hexdeck-server
	@echo "→ Building dashboard static export..."
	@$(NPM) run build --workspace=packages/dashboard-ui
	@$(NPM) run build --workspace=packages/local
	@echo "→ Staging resources into src-tauri/..."
	@mkdir -p packages/menubar/src-tauri/binaries
	@cp packages/server/dist/hexdeck-server packages/menubar/src-tauri/binaries/hexdeck-server
	@cp -r packages/local/out packages/menubar/src-tauri/dashboard
	@echo ""
	@echo "  ✓ Done. You can now run: cd packages/menubar && npm run dev"

# Dev: start server in dev mode (hot-reload)
.PHONY: dev-server
dev-server:
	@lsof -ti :$(API_PORT) | xargs -r kill 2>/dev/null || true
	cd packages/server && $(NPX) tsx watch src/server/main.ts

# Dev: reset the menubar/server race before starting the full dev stack.
# The menubar app auto-spawns its bundled server when :7433 is down, so quit it
# before clearing the server owner and launching the hot-reload dev server.
.PHONY: dev-clean
dev-clean:
	@osascript -e 'tell application "Hexdeck" to quit' >/dev/null 2>&1 || true
	@sleep 1
	@if [ -f "$(PID_FILE)" ]; then \
		pid=$$(node -e 'const fs = require("fs"); try { const pid = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).pid; if (Number.isInteger(pid)) console.log(pid); } catch {}' "$(PID_FILE)"); \
		if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping existing Hexdeck owner PID $$pid"; \
			kill "$$pid" 2>/dev/null || true; \
			sleep 1; \
			if kill -0 "$$pid" 2>/dev/null; then \
				echo "Force killing Hexdeck owner PID $$pid"; \
				kill -9 "$$pid" 2>/dev/null || true; \
			fi; \
		fi; \
	fi
	@lsof -ti :$(API_PORT) | xargs -r kill 2>/dev/null || true
	@rm -f "$(PID_FILE)" "$(STATE_LOCK)"
	$(NPM) run dev

# Dev: build menubar debug .app bundle (registers URL schemes with macOS)
.PHONY: dev-menubar
dev-menubar: prepare-menubar
	cd packages/menubar && $(NPM) run build -- --debug
	@echo ""
	@echo "  ✓ Debug build ready. Launch with:"
	@echo "    open packages/menubar/src-tauri/target/debug/bundle/macos/Hexdeck.app"

# Dev: launch the debug menubar .app
.PHONY: open-menubar
open-menubar:
	@test -d packages/menubar/src-tauri/target/debug/bundle/macos/Hexdeck.app || { \
		echo "  ✗ Debug build not found. Run 'make dev-menubar' first."; exit 1; \
	}
	open packages/menubar/src-tauri/target/debug/bundle/macos/Hexdeck.app

# Dev: test deep link (requires debug .app to be running)
.PHONY: test-deeplink
test-deeplink:
	@echo "Testing hexdeck:// deep link..."
	open "hexdeck://join?t=fake-token&p=fake-id&n=TestTeam"

# Install
.PHONY: install
install:
	$(NPM) install

# Build
.PHONY: build
build:
	$(NPM) run build

.PHONY: build-ui
build-ui:
	$(NPM) run build --workspace=packages/dashboard-ui

.PHONY: dashboard-version
dashboard-version:
	cd packages/dashboard-ui && $(NPM) version $(LEVEL) --no-git-tag-version

.PHONY: cli-version
cli-version:
	cd packages/cli && $(NPM) version $(LEVEL) --no-git-tag-version

.PHONY: typecheck
typecheck:
	cd packages/server && $(NPX) tsc --noEmit

# Cleanup
.PHONY: clean
clean:
	rm -rf node_modules packages/*/node_modules packages/server/dist packages/cli/dist packages/local/.next packages/local/out

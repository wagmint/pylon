/**
 * Bun-compilable standalone entry point for the Hexdeck server.
 * Parses --port and --dashboard-dir from argv, writes a PID file,
 * redirects logs to ~/.hexdeck/server.log, and cleans up on exit.
 */
import { startServer } from "./server/index.js";
import { removeHooks } from "./core/blocked.js";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { releaseStateLock } from "./storage/lock.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

const port = parseInt(getArg("--port") ?? "7433", 10);
const dashboardDir = getArg("--dashboard-dir") ?? undefined;

const HEXDECK_DIR = join(homedir(), ".hexdeck");
const PID_FILE = join(HEXDECK_DIR, "server.pid");
const LOG_FILE = join(HEXDECK_DIR, "server.log");

// Ensure ~/.hexdeck exists
if (!existsSync(HEXDECK_DIR)) {
  mkdirSync(HEXDECK_DIR, { recursive: true });
}

// Redirect stdout/stderr to log file
const logStream = createWriteStream(LOG_FILE, { flags: "a" });
process.stdout.write = logStream.write.bind(logStream) as typeof process.stdout.write;
process.stderr.write = logStream.write.bind(logStream) as typeof process.stderr.write;

function cleanup() {
  try {
    removeHooks();
  } catch {}
  try {
    releaseStateLock();
  } catch {}
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

startServer({ port, dashboardDir })
  .then(() => {
    const pidInfo = {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      dashboardDir: dashboardDir ?? null,
    };
    writeFileSync(PID_FILE, JSON.stringify(pidInfo, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

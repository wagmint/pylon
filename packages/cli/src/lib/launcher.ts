/**
 * Entry point for the detached background server process.
 * Reads --port and --dashboard-dir from argv.
 */
import { startServer } from "@hexdeck/server";

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

void startServer({ port, dashboardDir }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

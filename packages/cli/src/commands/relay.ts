import type { RelayTarget, RelayConfig, ParsedConnectLink, ExchangedRelayCredentials } from "@hexdeck/server";

export async function relayCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      return listRelays();
    case "remove":
      return removeRelay(args[1]);
    case "sessions":
      return listSessions();
    case "include":
      return includeProject(args[1], args.slice(2).join(" "));
    case "exclude":
      return excludeProject(args[1], args.slice(2).join(" "));
    default:
      // If it looks like a connect link, treat it as "connect"
      if (subcommand && subcommand.startsWith("hexcore+")) {
        return connectRelay(subcommand);
      }
      if (subcommand) {
        console.error(`Unknown relay subcommand: ${subcommand}`);
      }
      printRelayHelp();
      break;
  }
}

// ─── Connect ────────────────────────────────────────────────────────────────

async function connectRelay(link: string): Promise<void> {
  const { parseConnectLink, exchangeConnectLink, loadRelayConfig, saveRelayConfig } = await import("@hexdeck/server");

  let parsed: ParsedConnectLink;
  try {
    parsed = parseConnectLink(link);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : "Invalid connect link"}`);
    process.exit(1);
  }

  let creds: ExchangedRelayCredentials;
  try {
    creds = await exchangeConnectLink(parsed);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : "Connect exchange failed"}`);
    process.exit(1);
  }

  const { hexcoreId, hexcoreName, wsUrl, token, relayClientId, relayClientSecret } = creds;
  const config = loadRelayConfig();

  // Check for existing target with same hexcoreId
  const existing = config.targets.find((t) => t.hexcoreId === hexcoreId);
  if (existing) {
    // Update token/name
    existing.token = token;
    existing.relayClientId = relayClientId;
    existing.relayClientSecret = relayClientSecret;
    existing.hexcoreName = hexcoreName;
    existing.wsUrl = wsUrl;
    saveRelayConfig(config);
    console.log(`Updated relay target '${hexcoreName}' (${hexcoreId}).`);
  } else {
    const target: RelayTarget = {
      hexcoreId,
      hexcoreName,
      wsUrl,
      token,
      relayClientId,
      relayClientSecret,
      projects: [],
      addedAt: new Date().toISOString(),
    };
    config.targets.push(target);
    saveRelayConfig(config);
    console.log(`Relay configured for '${hexcoreName}'.`);
  }

  console.log("No sessions selected yet.");
  console.log("");
  console.log("Run `hex relay sessions` to see active sessions,");
  console.log("then `hex relay include <hexcoreId> <project>` to start sharing.");
}

// ─── List ───────────────────────────────────────────────────────────────────

async function listRelays(): Promise<void> {
  const { loadRelayConfig } = await import("@hexdeck/server");
  const config = loadRelayConfig();

  if (config.targets.length === 0) {
    console.log("No relay targets configured.");
    console.log("Use `hex relay <connect-link>` to add one.");
    return;
  }

  console.log("Relay Targets");
  console.log("─────────────────────────────");

  for (const target of config.targets) {
    console.log(`  ${target.hexcoreName}  (${target.hexcoreId.slice(0, 8)})`);
    if (target.projects.length === 0) {
      console.log("    No projects selected");
    } else {
      for (const p of target.projects) {
        console.log(`    ${p}`);
      }
    }
    console.log(`    Added: ${new Date(target.addedAt).toLocaleDateString()}`);
    console.log("");
  }
}

// ─── Remove ─────────────────────────────────────────────────────────────────

async function removeRelay(hexcoreIdPrefix?: string): Promise<void> {
  if (!hexcoreIdPrefix) {
    console.error("Usage: hex relay remove <hexcoreId>");
    process.exit(1);
  }

  const { loadRelayConfig, saveRelayConfig } = await import("@hexdeck/server");
  const config = loadRelayConfig();

  const matches = config.targets.filter((t) => t.hexcoreId.startsWith(hexcoreIdPrefix));

  if (matches.length === 0) {
    console.error(`No relay target found matching '${hexcoreIdPrefix}'.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Ambiguous prefix '${hexcoreIdPrefix}' matches ${matches.length} targets:`);
    for (const m of matches) {
      console.error(`  ${m.hexcoreId}  ${m.hexcoreName}`);
    }
    process.exit(1);
  }

  const target = matches[0];
  config.targets = config.targets.filter((t) => t.hexcoreId !== target.hexcoreId);
  saveRelayConfig(config);
  console.log(`Removed relay target '${target.hexcoreName}' (${target.hexcoreId}).`);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

async function listSessions(): Promise<void> {
  const { getActiveSessions } = await import("@hexdeck/server");
  const sessions = getActiveSessions();

  if (sessions.length === 0) {
    console.log("No active sessions found.");
    return;
  }

  // Group by project path
  const byProject = new Map<string, number>();
  for (const s of sessions) {
    byProject.set(s.projectPath, (byProject.get(s.projectPath) || 0) + 1);
  }

  // Sort by path
  const sorted = [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Abbreviate home dir
  const home = process.env.HOME || process.env.USERPROFILE || "";

  console.log("Active Sessions");
  console.log("─────────────────────────────");

  for (const [projectPath, count] of sorted) {
    const display = home ? projectPath.replace(home, "~") : projectPath;
    const label = count === 1 ? "session" : "sessions";
    console.log(`  ${display.padEnd(35)} ${count} ${label}`);
  }
}

// ─── Include ────────────────────────────────────────────────────────────────

async function includeProject(hexcoreIdPrefix?: string, projectPath?: string): Promise<void> {
  if (!hexcoreIdPrefix || !projectPath) {
    console.error("Usage: hex relay include <hexcoreId> <projectPath>");
    process.exit(1);
  }

  const { loadRelayConfig, saveRelayConfig } = await import("@hexdeck/server");
  const config = loadRelayConfig();
  const target = findTarget(config, hexcoreIdPrefix);

  // Normalize path: expand ~ to home dir
  const resolved = expandHome(projectPath);

  if (target.projects.includes(resolved)) {
    console.log(`Already relaying ${projectPath} to '${target.hexcoreName}'.`);
    return;
  }

  target.projects.push(resolved);
  saveRelayConfig(config);
  console.log(`Now relaying ${projectPath} to '${target.hexcoreName}'.`);
}

// ─── Exclude ────────────────────────────────────────────────────────────────

async function excludeProject(hexcoreIdPrefix?: string, projectPath?: string): Promise<void> {
  if (!hexcoreIdPrefix || !projectPath) {
    console.error("Usage: hex relay exclude <hexcoreId> <projectPath>");
    process.exit(1);
  }

  const { loadRelayConfig, saveRelayConfig } = await import("@hexdeck/server");
  const config = loadRelayConfig();
  const target = findTarget(config, hexcoreIdPrefix);

  const resolved = expandHome(projectPath);
  const idx = target.projects.indexOf(resolved);

  if (idx === -1) {
    console.log(`Not currently relaying ${projectPath} to '${target.hexcoreName}'.`);
    return;
  }

  target.projects.splice(idx, 1);
  saveRelayConfig(config);
  console.log(`Stopped relaying ${projectPath} to '${target.hexcoreName}'.`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findTarget(config: RelayConfig, prefix: string): RelayTarget {
  const matches = config.targets.filter((t) => t.hexcoreId.startsWith(prefix));

  if (matches.length === 0) {
    console.error(`No relay target found matching '${prefix}'.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Ambiguous prefix '${prefix}' matches ${matches.length} targets:`);
    for (const m of matches) {
      console.error(`  ${m.hexcoreId}  ${m.hexcoreName}`);
    }
    process.exit(1);
  }

  return matches[0];
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return home + p.slice(1);
  }
  return p;
}

function printRelayHelp(): void {
  console.log(`
Usage: hex relay <subcommand> [options]

Subcommands:
  <connect-link>                           Add/update a relay target
  list                                     List configured relay targets
  remove <hexcoreId>                         Remove a relay target
  sessions                                 List active sessions available to relay
  include <hexcoreId> <projectPath>          Start relaying a project
  exclude <hexcoreId> <projectPath>          Stop relaying a project

Examples:
  hex relay "hexcore+wss://relay.hexcore.app/ws?p=abc&c=connectCode&n=Team"
  hex relay list
  hex relay sessions
  hex relay include abc ~/Code/my-app
  hex relay exclude abc ~/Code/my-app
  hex relay remove abc
`.trim());
}

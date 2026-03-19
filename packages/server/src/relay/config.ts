import { readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import crypto from "crypto";
import type { RelayConfig, RelayTarget } from "./types.js";

// ─── Config Cache ───────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".hexdeck", "relay.json");
const KEY_PATH = join(homedir(), ".hexdeck", "relay.key");

let cachedConfig: RelayConfig | null = null;
let cachedMtimeMs = 0;
let cachedKey: Buffer | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load relay config from ~/.hexdeck/relay.json.
 * Cached by mtime — re-read on file change.
 * Missing or malformed config → empty { targets: [] }.
 */
export function loadRelayConfig(): RelayConfig {
  try {
    const stat = statSync(CONFIG_PATH);
    if (cachedConfig && stat.mtimeMs === cachedMtimeMs) {
      return cachedConfig;
    }

    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    cachedMtimeMs = stat.mtimeMs;
    cachedConfig = normalizeConfig(parsed);
    return cachedConfig;
  } catch {
    cachedConfig = { targets: [] };
    cachedMtimeMs = 0;
    return cachedConfig;
  }
}

/**
 * Save relay config to ~/.hexdeck/relay.json.
 * Creates ~/.hexdeck/ directory if it doesn't exist.
 */
export function saveRelayConfig(config: RelayConfig): void {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });

  const diskConfig: DiskRelayConfig = {
    targets: config.targets.map((target) => {
      const encryptedToken = encryptSecret(target.token);
      const encryptedRelayClientSecret = encryptSecret(target.relayClientSecret);
      return {
        hexcoreId: target.hexcoreId,
        hexcoreName: target.hexcoreName,
        wsUrl: target.wsUrl,
        tokenEnc: encryptedToken,
        relayClientId: target.relayClientId,
        relayClientSecretEnc: encryptedRelayClientSecret,
        projects: target.projects,
        addedAt: target.addedAt,
      };
    }),
  };

  const json = JSON.stringify(diskConfig, null, 2);
  writeFileSync(CONFIG_PATH, json, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Best effort.
  }
  // Invalidate cache so next load picks up the new mtime
  cachedConfig = null;
  cachedMtimeMs = 0;
}

// ─── Internal ───────────────────────────────────────────────────────────────

interface DiskRelayTarget {
  hexcoreId: string;
  hexcoreName?: string;
  wsUrl: string;
  token?: string;
  relayClientId?: string;
  relayClientSecret?: string;
  tokenEnc?: string;
  relayClientSecretEnc?: string;
  projects?: string[];
  addedAt?: string;
}

interface DiskRelayConfig {
  targets: DiskRelayTarget[];
}

function normalizeConfig(raw: unknown): RelayConfig {
  if (!raw || typeof raw !== "object") return { targets: [] };
  const obj = raw as Record<string, unknown>;
  const targets = Array.isArray(obj.targets) ? obj.targets : [];
  const normalizedTargets: RelayTarget[] = [];

  for (const target of targets) {
    const parsed = normalizeTarget(target);
    if (parsed) normalizedTargets.push(parsed);
  }

  return { targets: normalizedTargets };
}

function normalizeTarget(raw: unknown): RelayTarget | null {
  if (!isValidTarget(raw)) return null;

  const token = raw.tokenEnc ? decryptSecret(raw.tokenEnc) : raw.token;
  const relayClientSecret = raw.relayClientSecretEnc ? decryptSecret(raw.relayClientSecretEnc) : raw.relayClientSecret;
  if (!token || !raw.relayClientId || !relayClientSecret) return null;

  return {
    hexcoreId: raw.hexcoreId,
    hexcoreName: typeof raw.hexcoreName === "string" ? raw.hexcoreName : "Unnamed Relay",
    wsUrl: raw.wsUrl,
    token,
    relayClientId: raw.relayClientId,
    relayClientSecret,
    projects: Array.isArray(raw.projects) ? raw.projects.filter((p): p is string => typeof p === "string") : [],
    addedAt: typeof raw.addedAt === "string" ? raw.addedAt : new Date().toISOString(),
  };
}

function isValidTarget(t: unknown): t is DiskRelayTarget {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  const hasPlainToken = typeof o.token === "string" && typeof o.relayClientSecret === "string";
  const hasEncryptedToken = typeof o.tokenEnc === "string" && typeof o.relayClientSecretEnc === "string";
  return (
    typeof o.hexcoreId === "string" &&
    typeof o.wsUrl === "string" &&
    typeof o.relayClientId === "string" &&
    (hasPlainToken || hasEncryptedToken)
  );
}

function loadRelayKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.HEXCORE_RELAY_KEY;
  if (envKey) {
    const envBuf = Buffer.from(envKey, "base64");
    if (envBuf.length === 32) {
      cachedKey = envBuf;
      return cachedKey;
    }
  }

  const dir = dirname(KEY_PATH);
  mkdirSync(dir, { recursive: true });

  try {
    const existing = readFileSync(KEY_PATH, "utf-8").trim();
    const decoded = Buffer.from(existing, "base64");
    if (decoded.length === 32) {
      cachedKey = decoded;
      return cachedKey;
    }
  } catch {
    // Generate a key below.
  }

  const key = crypto.randomBytes(32);
  writeFileSync(KEY_PATH, key.toString("base64"), { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(KEY_PATH, 0o600);
  } catch {
    // Best effort.
  }
  cachedKey = key;
  return key;
}

function encryptSecret(value: string): string {
  const key = loadRelayKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(payload: string): string | null {
  const key = loadRelayKey();
  const parts = payload.split(":");
  if (parts.length !== 3) return null;

  try {
    const iv = Buffer.from(parts[0], "base64");
    const tag = Buffer.from(parts[1], "base64");
    const encrypted = Buffer.from(parts[2], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf-8");
  } catch {
    return null;
  }
}

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function resolveHomeDir(): string {
  return process.env.HEXDECK_HOME_DIR ?? homedir();
}

export const HEXDECK_DIR = join(resolveHomeDir(), ".hexdeck");
export const STATE_DB_PATH = join(HEXDECK_DIR, "state.db");
export const STATE_DB_WAL_PATH = join(HEXDECK_DIR, "state.db-wal");
export const STATE_DB_SHM_PATH = join(HEXDECK_DIR, "state.db-shm");
export const STATE_LOCK_PATH = join(HEXDECK_DIR, "state.lock");

export function ensureHexdeckDir(): string {
  if (!existsSync(HEXDECK_DIR)) {
    mkdirSync(HEXDECK_DIR, { recursive: true });
  }
  return HEXDECK_DIR;
}

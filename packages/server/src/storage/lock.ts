import { closeSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { isProcessRunning } from "../utils/process.js";
import { STATE_LOCK_PATH, ensureHexdeckDir } from "./paths.js";

let lockAcquired = false;
let cleanupRegistered = false;
const MAX_LOCK_ATTEMPTS = 3;

interface LockPayload {
  pid: number;
  acquiredAt: string;
}

export function acquireStateLock(): void {
  if (lockAcquired) return;

  ensureHexdeckDir();

  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(STATE_LOCK_PATH, "wx");
      const payload: LockPayload = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(fd, JSON.stringify(payload, null, 2));
      closeAndKeep(fd);
      registerCleanup();
      lockAcquired = true;
      return;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;

      const existing = readLockPayload();
      if (existing && existing.pid !== process.pid && isProcessRunning(existing.pid)) {
        throw new Error(`Hexdeck state is already owned by PID ${existing.pid}`);
      }

      // Stale lock or unreadable payload. Clear and retry once more.
      try {
        rmSync(STATE_LOCK_PATH, { force: true });
      } catch {}
    }
  }

  throw new Error("Failed to acquire Hexdeck state lock after multiple attempts");
}

export function releaseStateLock(): void {
  if (!lockAcquired) return;
  try {
    if (existsSync(STATE_LOCK_PATH)) {
      unlinkSync(STATE_LOCK_PATH);
    }
  } catch {}
  lockAcquired = false;
}

function readLockPayload(): LockPayload | null {
  try {
    return JSON.parse(readFileSync(STATE_LOCK_PATH, "utf-8")) as LockPayload;
  } catch {
    return null;
  }
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    releaseStateLock();
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST",
  );
}

function closeAndKeep(fd: number): void {
  try {
    // Writing via writeFileSync(fd, ...) does not close the descriptor.
    // Explicit close keeps the lock file on disk while avoiding an fd leak.
    closeSync(fd);
  } catch {}
}

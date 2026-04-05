import { existsSync, rmSync, statSync } from "node:fs";
import { acquireStateLock, releaseStateLock } from "./lock.js";
import { ensureMigrationTables, runMigrations } from "./migrations.js";
import { STATE_DB_PATH, STATE_DB_SHM_PATH, STATE_DB_WAL_PATH, ensureHexdeckDir } from "./paths.js";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

let db: SqliteDatabase | null = null;

export interface StorageInfo {
  dbPath: string;
  initializedAt: string;
  schemaVersion: number;
}

export interface StorageDiskUsage {
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
}

let storageInfo: StorageInfo | null = null;

export async function initStorage(): Promise<SqliteDatabase> {
  if (db) return db;

  ensureHexdeckDir();
  acquireStateLock();

  try {
    const database = await openSqliteDatabase(STATE_DB_PATH);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);

    ensureMigrationTables(database);
    const schemaVersion = runMigrations(database);

    const initializedAt = new Date().toISOString();
    const stmt = database.prepare(`
      INSERT INTO schema_meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING
    `);
    stmt.run("initialized_at", initializedAt);

    db = database;
    storageInfo = {
      dbPath: STATE_DB_PATH,
      initializedAt: getMetaValue(database, "initialized_at") ?? initializedAt,
      schemaVersion,
    };
    return db;
  } catch (error) {
    releaseStateLock();
    throw error;
  }
}

export function getDb(): SqliteDatabase {
  if (!db) {
    throw new Error("Hexdeck storage has not been initialized");
  }
  return db;
}

export function getStorageInfo(): StorageInfo {
  if (!storageInfo) {
    throw new Error("Hexdeck storage has not been initialized");
  }
  return storageInfo;
}

export function getStorageDiskUsage(): StorageDiskUsage {
  const dbBytes = getFileSizeSafe(STATE_DB_PATH);
  const walBytes = getFileSizeSafe(STATE_DB_WAL_PATH);
  const shmBytes = getFileSizeSafe(STATE_DB_SHM_PATH);
  return {
    dbBytes,
    walBytes,
    shmBytes,
    totalBytes: dbBytes + walBytes + shmBytes,
  };
}

export function withTransaction<T>(fn: () => T): T {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function closeStorage(): void {
  // Intentionally closes the DB connection only. The state lock remains held
  // by the current server process and is released on process cleanup.
  if (!db) return;
  db.close();
  db = null;
  storageInfo = null;
}

export async function rebuildStorage(): Promise<SqliteDatabase> {
  closeStorage();
  removeFileIfExists(STATE_DB_PATH);
  removeFileIfExists(STATE_DB_WAL_PATH);
  removeFileIfExists(STATE_DB_SHM_PATH);
  return initStorage();
}

function getMetaValue(database: SqliteDatabase, key: string): string | null {
  const row = database
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function getFileSizeSafe(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function removeFileIfExists(path: string): void {
  try {
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  } catch {}
}

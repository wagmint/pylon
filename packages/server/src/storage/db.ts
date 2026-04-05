import { acquireStateLock } from "./lock.js";
import { STATE_DB_PATH, ensureHexdeckDir } from "./paths.js";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

let db: SqliteDatabase | null = null;

export interface StorageInfo {
  dbPath: string;
  initializedAt: string;
}

let storageInfo: StorageInfo | null = null;

export async function initStorage(): Promise<SqliteDatabase> {
  if (db) return db;

  ensureHexdeckDir();
  acquireStateLock();

  const database = await openSqliteDatabase(STATE_DB_PATH);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);

  // Milestone 1 bootstrap schema: enough to prove durable ownership and
  // initialization without committing to the full parsed-evidence model yet.
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

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
  };
  return db;
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

function getMetaValue(database: SqliteDatabase, key: string): string | null {
  const row = database
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

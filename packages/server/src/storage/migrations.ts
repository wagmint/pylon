import type { SqliteDatabase } from "./sqlite.js";

interface Migration {
  id: number;
  name: string;
  up: string[];
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "baseline_storage",
    up: [
      `
      CREATE TABLE IF NOT EXISTS transcript_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL DEFAULT 0,
        file_mtime TEXT,
        discovered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(source_type, session_id),
        UNIQUE(file_path)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transcript_source_id INTEGER NOT NULL,
        parser_version TEXT NOT NULL,
        last_processed_line INTEGER NOT NULL DEFAULT 0,
        last_processed_byte_offset INTEGER NOT NULL DEFAULT 0,
        last_processed_timestamp TEXT,
        last_ingested_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        FOREIGN KEY(transcript_source_id) REFERENCES transcript_sources(id) ON DELETE CASCADE,
        UNIQUE(transcript_source_id)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        transcript_source_id INTEGER,
        project_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        git_branch TEXT,
        created_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'discovered',
        metadata_json TEXT,
        FOREIGN KEY(transcript_source_id) REFERENCES transcript_sources(id) ON DELETE SET NULL
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_transcript_sources_last_seen_at ON transcript_sources(last_seen_at)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)`,
    ],
  },
];

export function ensureMigrationTables(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function runMigrations(database: SqliteDatabase): number {
  const applied = new Set<number>(
    (
      database
        .prepare("SELECT id FROM schema_migrations ORDER BY id ASC")
        .all() as Array<{ id: number }>
    ).map((row) => row.id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      for (const sql of migration.up) {
        database.exec(sql);
      }
      database
        .prepare("INSERT INTO schema_migrations(id, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.id, migration.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  const latestVersion = MIGRATIONS.length === 0 ? 0 : MIGRATIONS[MIGRATIONS.length - 1].id;
  database
    .prepare(`
      INSERT INTO schema_meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    .run("schema_version", String(latestVersion));

  return latestVersion;
}

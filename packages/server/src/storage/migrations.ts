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
  {
    id: 2,
    name: "parsed_evidence_layer",
    up: [
      `
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        user_instruction TEXT NOT NULL,
        assistant_preview TEXT NOT NULL,
        has_commit INTEGER NOT NULL DEFAULT 0,
        has_push INTEGER NOT NULL DEFAULT 0,
        has_pull INTEGER NOT NULL DEFAULT 0,
        commit_message TEXT,
        commit_sha TEXT,
        has_error INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        has_compaction INTEGER NOT NULL DEFAULT 0,
        compaction_text TEXT,
        has_plan_start INTEGER NOT NULL DEFAULT 0,
        has_plan_end INTEGER NOT NULL DEFAULT 0,
        plan_markdown TEXT,
        plan_rejected INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        context_window_tokens INTEGER,
        duration_ms INTEGER,
        sections_json TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, turn_index)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER,
        line_number INTEGER NOT NULL,
        role TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT,
        text TEXT,
        plan_content TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER,
        line_number INTEGER NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT,
        text TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER,
        line_number INTEGER NOT NULL,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        timestamp TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS tool_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER,
        line_number INTEGER NOT NULL,
        tool_use_id TEXT NOT NULL,
        content TEXT NOT NULL,
        is_error INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS file_touches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER,
        line_number INTEGER NOT NULL,
        tool_call_id TEXT,
        file_path TEXT,
        action TEXT NOT NULL,
        source_tool TEXT NOT NULL,
        detail TEXT,
        timestamp TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER,
        line_number INTEGER NOT NULL,
        tool_call_id TEXT NOT NULL,
        command_text TEXT NOT NULL,
        is_git_commit INTEGER NOT NULL DEFAULT 0,
        is_git_push INTEGER NOT NULL DEFAULT 0,
        is_git_pull INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        command_tool_call_id TEXT,
        commit_message TEXT,
        commit_sha TEXT,
        timestamp TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        approval_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        timestamp TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER,
        line_number INTEGER NOT NULL,
        tool_use_id TEXT,
        tool_name TEXT,
        message TEXT NOT NULL,
        timestamp TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        source TEXT NOT NULL,
        ordinal INTEGER,
        task_id TEXT,
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT,
        raw_text TEXT,
        timestamp TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_turns_session_turn_index ON turns(session_id, turn_index)`,
      `CREATE INDEX IF NOT EXISTS idx_events_session_line_number ON events(session_id, line_number)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_session_line_number ON messages(session_id, line_number)`,
      `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_turn_index ON tool_calls(session_id, turn_index)`,
      `CREATE INDEX IF NOT EXISTS idx_tool_results_session_turn_index ON tool_results(session_id, turn_index)`,
      `CREATE INDEX IF NOT EXISTS idx_file_touches_session_turn_index ON file_touches(session_id, turn_index)`,
      `CREATE INDEX IF NOT EXISTS idx_commands_session_turn_index ON commands(session_id, turn_index)`,
      `CREATE INDEX IF NOT EXISTS idx_commits_session_turn_index ON commits(session_id, turn_index)`,
      `CREATE INDEX IF NOT EXISTS idx_approvals_session_turn_index ON approvals(session_id, turn_index)`,
      `CREATE INDEX IF NOT EXISTS idx_errors_session_turn_index ON errors(session_id, turn_index)`,
      `CREATE INDEX IF NOT EXISTS idx_plan_items_session_turn_index ON plan_items(session_id, turn_index)`,
    ],
  },
  {
    id: 3,
    name: "session_state_model",
    up: [
      `
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        derived_at TEXT NOT NULL,
        status TEXT NOT NULL,
        current_goal TEXT NOT NULL,
        last_meaningful_action TEXT NOT NULL,
        resume_summary TEXT NOT NULL,
        blocked_reason TEXT,
        pending_approval_count INTEGER NOT NULL DEFAULT 0,
        files_in_play_json TEXT NOT NULL,
        last_turn_index INTEGER,
        last_event_at TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_session_state_status ON session_state(status)`,
      `CREATE INDEX IF NOT EXISTS idx_session_state_last_event_at ON session_state(last_event_at)`,
    ],
  },
  {
    id: 4,
    name: "task_extraction",
    up: [
      `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(source_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(project_path, canonical_key)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS session_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        derived_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(session_id, task_id)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS task_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_row_id TEXT,
        snippet TEXT,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_tasks_project_path ON tasks(project_path)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
      `CREATE INDEX IF NOT EXISTS idx_session_tasks_session_id ON session_tasks(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_session_tasks_task_id ON session_tasks(task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_task_evidence_task_id ON task_evidence(task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_task_evidence_session_id ON task_evidence(session_id)`,
    ],
  },
  {
    id: 5,
    name: "workstream_model",
    up: [
      `
      CREATE TABLE IF NOT EXISTS workstreams (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL UNIQUE,
        canonical_key TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS workstream_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        derived_at TEXT NOT NULL,
        FOREIGN KEY(workstream_id) REFERENCES workstreams(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(workstream_id, task_id)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS workstream_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        derived_at TEXT NOT NULL,
        FOREIGN KEY(workstream_id) REFERENCES workstreams(id) ON DELETE CASCADE,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(workstream_id, session_id)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS workstream_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_row_id TEXT,
        snippet TEXT,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(workstream_id) REFERENCES workstreams(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS workstream_state (
        workstream_id TEXT PRIMARY KEY,
        derived_at TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        active_task_count INTEGER NOT NULL DEFAULT 0,
        blocked_task_count INTEGER NOT NULL DEFAULT 0,
        stalled_task_count INTEGER NOT NULL DEFAULT 0,
        completed_task_count INTEGER NOT NULL DEFAULT 0,
        session_count INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL,
        last_activity_at TEXT,
        FOREIGN KEY(workstream_id) REFERENCES workstreams(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_workstreams_project_path ON workstreams(project_path)`,
      `CREATE INDEX IF NOT EXISTS idx_workstreams_status ON workstreams(status)`,
      `CREATE INDEX IF NOT EXISTS idx_workstream_tasks_workstream_id ON workstream_tasks(workstream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_workstream_tasks_task_id ON workstream_tasks(task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_workstream_sessions_workstream_id ON workstream_sessions(workstream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_workstream_sessions_session_id ON workstream_sessions(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_workstream_evidence_workstream_id ON workstream_evidence(workstream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_workstream_state_status ON workstream_state(status)`,
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

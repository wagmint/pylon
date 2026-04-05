export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export async function openSqliteDatabase(path: string): Promise<SqliteDatabase> {
  if (isBunRuntime()) {
    const mod = await import("bun:sqlite");
    const db = new mod.Database(path);
    return {
      exec(sql: string) {
        db.exec(sql);
      },
      prepare(sql: string): SqliteStatement {
        const query = db.query(sql) as {
          run(...params: any[]): unknown;
          get(...params: any[]): unknown;
        };
        return {
          run(...params: unknown[]) {
            return query.run(...params);
          },
          get(...params: unknown[]) {
            return query.get(...params);
          },
        };
      },
      close() {
        db.close();
      },
    };
  }

  const mod = await import("node:sqlite");
  const db = new mod.DatabaseSync(path);
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql) as {
        run(...params: any[]): unknown;
        get(...params: any[]): unknown;
      };
      return {
        run(...params: unknown[]) {
          return stmt.run(...params);
        },
        get(...params: unknown[]) {
          return stmt.get(...params);
        },
      };
    },
    close() {
      db.close();
    },
  };
}

function isBunRuntime(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.bun === "string";
}

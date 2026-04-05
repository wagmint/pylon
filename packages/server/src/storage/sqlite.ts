export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export async function openSqliteDatabase(path: string): Promise<SqliteDatabase> {
  if (isBunRuntime()) {
    const mod = await runtimeImport("bun:sqlite") as typeof import("bun:sqlite");
    const db = new mod.Database(path);
    return {
      exec(sql: string) {
        db.exec(sql);
      },
      prepare(sql: string): SqliteStatement {
        const query = db.query(sql) as {
          run(...params: any[]): unknown;
          get(...params: any[]): unknown;
          all(...params: any[]): unknown[];
        };
        return {
          run(...params: unknown[]) {
            return query.run(...params);
          },
          get(...params: unknown[]) {
            return query.get(...params);
          },
          all(...params: unknown[]) {
            return query.all(...params);
          },
        };
      },
      close() {
        db.close();
      },
    };
  }

  const mod = await runtimeImport("node:sqlite") as typeof import("node:sqlite");
  const db = new mod.DatabaseSync(path);
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql) as {
        run(...params: any[]): unknown;
        get(...params: any[]): unknown;
        all(...params: any[]): unknown[];
      };
      return {
        run(...params: unknown[]) {
          return stmt.run(...params);
        },
        get(...params: unknown[]) {
          return stmt.get(...params);
        },
        all(...params: unknown[]) {
          return stmt.all(...params);
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

function runtimeImport(specifier: string): Promise<unknown> {
  return new Function("s", "return import(s)")(
    specifier,
  ) as Promise<unknown>;
}

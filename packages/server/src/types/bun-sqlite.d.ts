declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: unknown);
    exec(sql: string): void;
    query(sql: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}

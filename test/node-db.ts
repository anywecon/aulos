import Database from 'better-sqlite3';

import type { Db, RunResult, SqlParams, SqlValue } from '@/db/types';

type BindValue = string | number | null | Buffer;

function toBind(params: SqlParams): BindValue[] {
  return params.map((v: SqlValue) => (v instanceof Uint8Array ? Buffer.from(v) : v));
}

/**
 * better-sqlite3 registers its SqliteError constructor with the native addon once per process, so
 * in every Jest test file after the first one SQLite errors come from another realm and are not
 * `instanceof Error` there (Jest's `toThrow` then sees no error). Re-throw them as local Errors.
 */
function sqlite<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error) throw error;
    const { message, name, code } = error as { message?: unknown; name?: unknown; code?: unknown };
    const local = new Error(typeof message === 'string' ? message : String(error));
    if (typeof name === 'string') local.name = name;
    throw typeof code === 'string' ? Object.assign(local, { code }) : local;
  }
}

export interface NodeDb extends Db {
  close(): void;
}

/** better-sqlite3 implementation of Db, used only by Jest. Same pragmas as the device. */
export function openNodeDb(filename = ':memory:'): NodeDb {
  const conn = new Database(filename);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  let inTransaction = false;

  const db: NodeDb = {
    async exec(sql) {
      sqlite(() => conn.exec(sql));
    },
    async run(sql, params = []): Promise<RunResult> {
      const r = sqlite(() => conn.prepare(sql).run(...toBind(params)));
      return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async getAll<T>(sql: string, params: SqlParams = []) {
      return sqlite(() => conn.prepare<BindValue[], T>(sql).all(...toBind(params)));
    },
    async getFirst<T>(sql: string, params: SqlParams = []) {
      return sqlite(() => conn.prepare<BindValue[], T>(sql).get(...toBind(params))) ?? null;
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (inTransaction) return fn(db);
      sqlite(() => conn.exec('BEGIN IMMEDIATE'));
      inTransaction = true;
      try {
        const result = await fn(db);
        sqlite(() => conn.exec('COMMIT'));
        return result;
      } catch (error) {
        sqlite(() => conn.exec('ROLLBACK'));
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      conn.close();
    },
  };
  return db;
}

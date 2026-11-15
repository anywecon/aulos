import * as SQLite from 'expo-sqlite';

import { assertFts5 } from './fts';
import { migrate } from './migrate';
import { MIGRATIONS } from './migrations';
import type { Db, RunResult, SqlParams } from './types';

export const DATABASE_NAME = 'aulos.db';

/**
 * A write on one connection waits this long for another connection's write transaction instead
 * of failing at once with "database is locked" (a first scan of a large library takes seconds).
 */
export const BUSY_TIMEOUT_MS = 30_000;

/** Per-connection settings; SQLite keeps none of them in the database file. */
export const CONNECTION_PRAGMAS = `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`;

export type Connection = Pick<
  SQLite.SQLiteDatabase,
  'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync' | 'closeAsync'
>;

/**
 * Runs transactions one at a time on a dedicated connection, so queries on the main connection
 * never interleave with them. expo-sqlite's withExclusiveTransactionAsync also uses a separate
 * connection, but opens a new one without our pragmas: foreign keys were off inside every
 * transaction (no ON DELETE CASCADE when a scan removed tracks), and a competing write failed
 * with "database is locked" instead of waiting.
 */
export class TransactionRunner {
  readonly #open: () => Promise<Connection>;
  #connection: Promise<Connection> | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(open: () => Promise<Connection>) {
    this.#open = open;
  }

  async run<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const conn = await this.#connect();
      await conn.execAsync('BEGIN IMMEDIATE');
      try {
        const result = await fn(new ExpoDb(conn, null));
        await conn.execAsync('COMMIT');
        return result;
      } catch (error) {
        try {
          await conn.execAsync('ROLLBACK');
        } catch {
          // SQLite may already have rolled back, or the connection is unusable: start the next
          // transaction on a fresh connection. Keep the original error.
          this.#connection = null;
          await conn.closeAsync().catch(() => undefined);
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  #connect(): Promise<Connection> {
    if (!this.#connection) {
      const opening = (async () => {
        const conn = await this.#open();
        try {
          await conn.execAsync(CONNECTION_PRAGMAS);
        } catch (error) {
          await conn.closeAsync().catch(() => undefined);
          throw error;
        }
        return conn;
      })();
      // A failed open is retried by the next transaction.
      opening.catch(() => {
        if (this.#connection === opening) this.#connection = null;
      });
      this.#connection = opening;
    }
    return this.#connection;
  }
}

/** `transactions` is null on a transaction's own handle: nested calls join that transaction. */
export class ExpoDb implements Db {
  readonly #conn: Connection;
  readonly #transactions: TransactionRunner | null;

  constructor(conn: Connection, transactions: TransactionRunner | null) {
    this.#conn = conn;
    this.#transactions = transactions;
  }

  async exec(sql: string): Promise<void> {
    await this.#conn.execAsync(sql);
  }

  async run(sql: string, params: SqlParams = []): Promise<RunResult> {
    const result = await this.#conn.runAsync(sql, [...params]);
    return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
  }

  getAll<T>(sql: string, params: SqlParams = []): Promise<T[]> {
    return this.#conn.getAllAsync<T>(sql, [...params]);
  }

  getFirst<T>(sql: string, params: SqlParams = []): Promise<T | null> {
    return this.#conn.getFirstAsync<T>(sql, [...params]);
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.#transactions) return fn(this);
    return this.#transactions.run(fn);
  }
}

/**
 * Opens the app database (WAL, foreign keys on, busy timeout), checks FTS5 and applies
 * migrations.
 */
export async function openAppDb(): Promise<Db> {
  const conn = await SQLite.openDatabaseAsync(DATABASE_NAME);
  await conn.execAsync(`PRAGMA journal_mode = WAL; ${CONNECTION_PRAGMAS}`);
  const transactions = new TransactionRunner(() =>
    SQLite.openDatabaseAsync(DATABASE_NAME, { useNewConnection: true }),
  );
  const db = new ExpoDb(conn, transactions);
  await assertFts5(db);
  await migrate(db, MIGRATIONS);
  return db;
}

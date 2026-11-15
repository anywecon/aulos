/**
 * @jest-environment node
 */
import * as SQLite from 'expo-sqlite';

import { ExpoDb, openAppDb, TransactionRunner, type Connection } from '../expo-db';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../fts', () => ({ assertFts5: jest.fn(async () => undefined) }));
jest.mock('../migrate', () => ({ migrate: jest.fn(async () => []) }));

/** Records every statement and close; `failOn` makes a matching statement reject. */
function fakeConnection(name: string, log: string[], failOn?: RegExp): Connection {
  const record = async (sql: string) => {
    log.push(`${name}: ${sql}`);
    if (failOn?.test(sql)) throw new Error(`failed: ${sql}`);
  };
  return {
    execAsync: record,
    runAsync: (async (sql: string) => {
      await record(sql);
      return { changes: 1, lastInsertRowId: 1 };
    }) as Connection['runAsync'],
    getAllAsync: (async (sql: string) => {
      await record(sql);
      return [];
    }) as Connection['getAllAsync'],
    getFirstAsync: (async (sql: string) => {
      await record(sql);
      return null;
    }) as Connection['getFirstAsync'],
    closeAsync: async () => {
      log.push(`${name}: close`);
    },
  };
}

const PRAGMAS = 'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;';

describe('TransactionRunner', () => {
  it('runs transactions on one dedicated connection with foreign keys and a busy timeout', async () => {
    const log: string[] = [];
    let opened = 0;
    const runner = new TransactionRunner(async () => {
      opened += 1;
      return fakeConnection('tx', log);
    });
    const db = new ExpoDb(fakeConnection('main', log), runner);

    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM tracks WHERE id = ?', [2]);
      // Nested calls join the open transaction.
      await tx.transaction(async (inner) => inner.run('DELETE FROM history'));
    });
    await db.transaction(async (tx) => tx.getAll('SELECT 1'));
    await db.run('INSERT INTO kv VALUES (1)');

    expect(opened).toBe(1);
    expect(log).toEqual([
      `tx: ${PRAGMAS}`,
      'tx: BEGIN IMMEDIATE',
      'tx: DELETE FROM tracks WHERE id = ?',
      'tx: DELETE FROM history',
      'tx: COMMIT',
      'tx: BEGIN IMMEDIATE',
      'tx: SELECT 1',
      'tx: COMMIT',
      'main: INSERT INTO kv VALUES (1)',
    ]);
  });

  it('runs concurrent transactions one after the other', async () => {
    const log: string[] = [];
    const runner = new TransactionRunner(async () => fakeConnection('tx', log));
    let releaseFirst = () => {};
    const first = runner.run(async (tx) => {
      await tx.run('first');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return 1;
    });
    const second = runner.run(async (tx) => {
      await tx.run('second');
      return 2;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).not.toContain('tx: second');
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(log.slice(1)).toEqual([
      'tx: BEGIN IMMEDIATE',
      'tx: first',
      'tx: COMMIT',
      'tx: BEGIN IMMEDIATE',
      'tx: second',
      'tx: COMMIT',
    ]);
  });

  it('rolls back and rethrows a failed transaction, then keeps working', async () => {
    const log: string[] = [];
    const runner = new TransactionRunner(async () => fakeConnection('tx', log, /^boom$/));
    await expect(runner.run(async (tx) => tx.run('boom'))).rejects.toThrow('failed: boom');
    await expect(runner.run(async () => 'ok')).resolves.toBe('ok');
    expect(log.slice(1)).toEqual([
      'tx: BEGIN IMMEDIATE',
      'tx: boom',
      'tx: ROLLBACK',
      'tx: BEGIN IMMEDIATE',
      'tx: COMMIT',
    ]);
  });

  it('rolls back when COMMIT fails and releases the lock when BEGIN fails', async () => {
    const log: string[] = [];
    const commitFails = new TransactionRunner(async () => fakeConnection('tx', log, /^COMMIT$/));
    await expect(commitFails.run(async () => 'x')).rejects.toThrow('failed: COMMIT');
    expect(log.slice(-1)).toEqual(['tx: ROLLBACK']);

    let beginFails = true;
    const busy = new TransactionRunner(async () => ({
      ...fakeConnection('busy', log),
      execAsync: async (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && beginFails) throw new Error('database is locked');
      },
    }));
    await expect(busy.run(async () => 'x')).rejects.toThrow('database is locked');
    beginFails = false;
    await expect(busy.run(async () => 'y')).resolves.toBe('y');
  });

  it('starts over on a fresh connection when ROLLBACK fails', async () => {
    const log: string[] = [];
    let opened = 0;
    const runner = new TransactionRunner(async () => {
      opened += 1;
      return fakeConnection(`tx${opened}`, log, opened === 1 ? /^(boom|ROLLBACK)$/ : undefined);
    });
    await expect(runner.run(async (tx) => tx.run('boom'))).rejects.toThrow('failed: boom');
    await expect(runner.run(async () => 'ok')).resolves.toBe('ok');
    expect(opened).toBe(2);
    expect(log).toContain('tx1: close');
    expect(log.slice(-3)).toEqual([`tx2: ${PRAGMAS}`, 'tx2: BEGIN IMMEDIATE', 'tx2: COMMIT']);
  });

  it('closes a connection whose pragmas fail and opens it again next time', async () => {
    const log: string[] = [];
    let attempts = 0;
    const runner = new TransactionRunner(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('cannot open');
      return fakeConnection(`tx${attempts}`, log, attempts === 2 ? /^PRAGMA/ : undefined);
    });
    await expect(runner.run(async () => 'x')).rejects.toThrow('cannot open');
    await expect(runner.run(async () => 'x')).rejects.toThrow('failed: PRAGMA');
    await expect(runner.run(async () => 'y')).resolves.toBe('y');
    expect(attempts).toBe(3);
    expect(log).toContain('tx2: close');
  });
});

describe('openAppDb', () => {
  it('sets WAL, foreign keys and the busy timeout, and opens transactions separately', async () => {
    const log: string[] = [];
    const open = jest.mocked(SQLite.openDatabaseAsync);
    open.mockImplementation(
      async (_name, options) =>
        fakeConnection(options?.useNewConnection ? 'tx' : 'main', log) as SQLite.SQLiteDatabase,
    );

    const db = await openAppDb();
    await db.transaction(async (tx) => tx.run('DELETE FROM history'));

    expect(open.mock.calls).toEqual([['aulos.db'], ['aulos.db', { useNewConnection: true }]]);
    expect(log).toEqual([
      `main: PRAGMA journal_mode = WAL; ${PRAGMAS}`,
      `tx: ${PRAGMAS}`,
      'tx: BEGIN IMMEDIATE',
      'tx: DELETE FROM history',
      'tx: COMMIT',
    ]);
  });
});

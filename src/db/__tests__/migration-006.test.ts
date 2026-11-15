/**
 * @jest-environment node
 */
import { openNodeDb, type NodeDb } from '../../../test/node-db';
import { migrate } from '../migrate';
import { MIGRATIONS } from '../migrations';

const V5 = MIGRATIONS.filter((m) => m.version <= 5);

const count = async (db: NodeDb, table: string) =>
  (await db.getFirst<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n;

describe('migration 006 (orphan rows)', () => {
  let db: NodeDb;
  beforeEach(async () => {
    db = openNodeDb();
    await migrate(db, V5);
    await db.run(
      `INSERT INTO tracks (id, provider, provider_ref, title, artist, album, local_path, title_norm,
                           artist_norm, album_norm, album_key)
       VALUES (1, 'local', '1', 'Kept', 'A', 'Album', 'content://media/1', 'kept', 'a', 'album',
               'k1'),
              (2, 'local', '2', 'Removed', 'A', 'Album', 'content://media/2', 'removed', 'a',
               'album', 'k1')`,
    );
    await db.run("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (1, 'p', 0, 0)");
    await db.run(
      'INSERT INTO playlist_items (playlist_id, position, track_id) VALUES (1, 0, 1), (1, 1, 2)',
    );
    await db.run(
      'INSERT INTO history (track_id, played_at, ms_played) VALUES (1, 10, 1000), (2, 20, 1000)',
    );
    await db.run(
      `INSERT INTO downloads (track_id, status, format, file_name, created_at, updated_at)
       VALUES (1, 'completed', 'mp3', 'a.mp3', 0, 0), (2, 'completed', 'mp3', 'b.mp3', 0, 0)`,
    );
    await db.run(
      `INSERT INTO favorites (kind, key, added_at)
       VALUES ('track', '1', 0), ('track', '2', 0), ('album', 'k1', 0)`,
    );
    // What the device did until 1.0.0: delete inside a transaction with foreign keys off.
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run('DELETE FROM tracks WHERE id = 2');
    await db.exec('PRAGMA foreign_keys = ON');
  });
  afterEach(() => db.close());

  it('removes playlist items, history and downloads of deleted tracks', async () => {
    expect(await count(db, 'playlist_items')).toBe(2);
    expect(await migrate(db, MIGRATIONS)).toEqual([6]);
    expect(await db.getAll('SELECT track_id FROM playlist_items')).toEqual([{ track_id: 1 }]);
    expect(await db.getAll('SELECT track_id FROM history')).toEqual([{ track_id: 1 }]);
    expect(await db.getAll('SELECT track_id FROM downloads')).toEqual([{ track_id: 1 }]);
    expect(await db.getAll('SELECT kind, key FROM favorites ORDER BY kind, key')).toEqual([
      { kind: 'album', key: 'k1' },
      { kind: 'track', key: '1' },
    ]);
    expect(await count(db, 'tracks')).toBe(1);
    expect(await db.getAll('PRAGMA foreign_key_check')).toEqual([]);
  });
});

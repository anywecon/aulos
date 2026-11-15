/**
 * @jest-environment node
 */
import { openNodeDb, type NodeDb } from '../../../test/node-db';
import { migrate } from '../migrate';
import { MIGRATIONS } from '../migrations';
import { deleteOrphanRows } from '../migrations/006_orphan_rows';

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
  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    info.mockRestore();
    db.close();
  });

  it('removes only rows whose track is gone, and logs the counts', async () => {
    expect(await count(db, 'playlist_items')).toBe(2);
    expect(await migrate(db, MIGRATIONS)).toEqual([6]);
    expect(info).toHaveBeenCalledWith(
      'Aulos migration 006: orphan rows removed {"playlistItems":1,"history":1,"downloads":1,"trackFavorites":1}',
    );
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

  it('changes nothing when every row points at an existing track', async () => {
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run('DELETE FROM playlist_items WHERE track_id = 2');
    await db.run('DELETE FROM history WHERE track_id = 2');
    await db.run('DELETE FROM downloads WHERE track_id = 2');
    await db.run("DELETE FROM favorites WHERE kind = 'track' AND key = '2'");
    await db.run('PRAGMA foreign_keys = ON');
    const snapshot = async () => ({
      items: await db.getAll('SELECT * FROM playlist_items ORDER BY position'),
      history: await db.getAll('SELECT * FROM history ORDER BY id'),
      downloads: await db.getAll('SELECT * FROM downloads ORDER BY track_id'),
      favorites: await db.getAll('SELECT * FROM favorites ORDER BY kind, key'),
    });
    const before = await snapshot();
    expect(await deleteOrphanRows(db)).toEqual({
      playlistItems: 0,
      history: 0,
      downloads: 0,
      trackFavorites: 0,
    });
    expect(await snapshot()).toEqual(before);
    expect(before.items).toHaveLength(1);
    expect(before.favorites).toHaveLength(2);
  });

  it('logs zero counts on a library without orphans, and nothing on a fresh install', async () => {
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run('DELETE FROM playlist_items WHERE track_id = 2');
    await db.run('DELETE FROM history WHERE track_id = 2');
    await db.run('DELETE FROM downloads WHERE track_id = 2');
    await db.run("DELETE FROM favorites WHERE kind = 'track' AND key = '2'");
    await db.run('PRAGMA foreign_keys = ON');
    expect(await migrate(db, MIGRATIONS)).toEqual([6]);
    expect(info).toHaveBeenCalledWith(
      'Aulos migration 006: orphan rows removed {"playlistItems":0,"history":0,"downloads":0,"trackFavorites":0}',
    );

    info.mockClear();
    const fresh = openNodeDb();
    expect(await migrate(fresh, MIGRATIONS)).toEqual([1, 2, 3, 4, 5, 6]);
    fresh.close();
    expect(info).not.toHaveBeenCalled();
  });
});

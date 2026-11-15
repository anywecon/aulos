/**
 * @jest-environment node
 */
import { mediaAudio } from '../../../test/fixtures';
import { openNodeDb, type NodeDb } from '../../../test/node-db';
import { migrate } from '../../db/migrate';
import { MIGRATIONS } from '../../db/migrations';
import { countLocalTracks, scanLibrary, shouldHoldRemovals } from '../scan';

jest.mock('../../../modules/media-store', () => ({ queryAudio: jest.fn() }));

const audio = mediaAudio;

const clock = () => {
  let t = 1000;
  return () => (t += 250);
};

describe('scanLibrary', () => {
  let db: NodeDb;
  beforeEach(async () => {
    db = openNodeDb();
    await migrate(db, MIGRATIONS);
  });
  afterEach(() => db.close());

  it('inserts local tracks on the first scan', async () => {
    const result = await scanLibrary(db, {
      query: async () => [audio('1'), audio('2')],
      now: clock(),
    });
    expect(result).toEqual({
      added: 2,
      updated: 0,
      removed: 0,
      total: 2,
      durationMs: 500,
      held: 0,
    });
    expect(await countLocalTracks(db)).toBe(2);
    expect(
      await db.getFirst(
        "SELECT provider, provider_ref, local_path FROM tracks WHERE provider_ref = '1'",
      ),
    ).toEqual({
      provider: 'local',
      provider_ref: '1',
      local_path: 'content://media/external/audio/media/1',
    });
  });

  it('is idempotent when nothing changed', async () => {
    await scanLibrary(db, { query: async () => [audio('1')] });
    const result = await scanLibrary(db, { query: async () => [audio('1')] });
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, total: 1 });
  });

  it('updates changed rows in place and removes vanished files', async () => {
    await scanLibrary(db, { query: async () => [audio('1'), audio('2')] });
    const before = await db.getFirst<{ id: number }>(
      "SELECT id FROM tracks WHERE provider_ref = '1'",
    );

    const result = await scanLibrary(db, {
      query: async () => [audio('1', { title: 'Renamed' }), audio('3')],
    });

    expect(result).toMatchObject({ added: 1, updated: 1, removed: 1, total: 2 });
    expect(await db.getFirst("SELECT id, title FROM tracks WHERE provider_ref = '1'")).toEqual({
      id: before?.id,
      title: 'Renamed',
    });
    expect(await db.getFirst("SELECT id FROM tracks WHERE provider_ref = '2'")).toBeNull();
  });

  it("drops a removed track's favourite so a reused id does not inherit it", async () => {
    await scanLibrary(db, { query: async () => [audio('1'), audio('2')] });
    const ids = await db.getAll<{ id: number }>('SELECT id FROM tracks ORDER BY id');
    for (const { id } of ids) {
      await db.run("INSERT INTO favorites (kind, key, added_at) VALUES ('track', ?, 0)", [
        String(id),
      ]);
    }
    await db.run("INSERT INTO favorites (kind, key, added_at) VALUES ('album', 'some-album', 0)");

    await scanLibrary(db, { query: async () => [audio('1')] });

    expect(await db.getAll('SELECT kind, key FROM favorites ORDER BY kind, key')).toEqual([
      { kind: 'album', key: 'some-album' },
      { kind: 'track', key: String(ids[0]?.id) },
    ]);
  });

  it('never touches tracks from other providers', async () => {
    await db.run(
      "INSERT INTO tracks (provider, provider_ref, title) VALUES ('archive', 'x', 'Remote')",
    );
    const result = await scanLibrary(db, { query: async () => [] });
    expect(result).toMatchObject({ removed: 0, total: 0 });
    expect(await db.getFirst('SELECT COUNT(*) AS n FROM tracks')).toEqual({ n: 1 });
  });

  it('keeps search in sync with the scan', async () => {
    await scanLibrary(db, { query: async () => [audio('1', { title: 'Zorba' })] });
    await scanLibrary(db, { query: async () => [audio('1', { title: 'Sirtaki' })] });
    const hits = await db.getAll("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'zorba'");
    expect(hits).toEqual([]);
    const renamed = await db.getAll(
      "SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'sirtaki'",
    );
    expect(renamed).toHaveLength(1);
  });

  it('rolls back the whole scan when a write fails', async () => {
    await scanLibrary(db, { query: async () => [audio('1')] });
    await db.run(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON tracks BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    await expect(scanLibrary(db, { query: async () => [audio('2')] })).rejects.toThrow(/boom/);
    expect(await db.getAll('SELECT provider_ref FROM tracks')).toEqual([{ provider_ref: '1' }]);
  });
  it('leaves excluded folders out and drops rows that were already stored', async () => {
    const library = [
      audio('1', { folder: 'Music/Keep/' }),
      audio('2', { folder: 'Music/Podcasts/' }),
      audio('3', { folder: 'Music/Podcasts/2024/' }),
    ];
    await scanLibrary(db, { query: async () => library });
    const result = await scanLibrary(db, {
      query: async () => library,
      excludedFolders: ['Music/Podcasts/'],
    });
    expect(result).toMatchObject({ added: 0, removed: 2, total: 1 });
    expect(await db.getAll('SELECT provider_ref FROM tracks')).toEqual([{ provider_ref: '1' }]);
  });

  it('writes the normalised search columns, year and date added', async () => {
    await scanLibrary(db, {
      query: async () => [
        audio('1', {
          title: 'Τα Παιδιά',
          artist: 'Μάνος Χατζιδάκις',
          album: null,
          albumArtist: 'ΜΆΝΟΣ',
          year: 1960,
          dateAdded: 42,
        }),
      ],
    });
    expect(
      await db.getFirst(
        'SELECT title_norm, artist_norm, album_norm, album_artist_norm, year, added_at FROM tracks',
      ),
    ).toEqual({
      title_norm: 'τα παιδια',
      artist_norm: 'μανοσ χατζιδακισ',
      album_norm: null,
      album_artist_norm: 'μανοσ',
      year: 1960,
      added_at: 42,
    });
  });
});

describe('removal guard', () => {
  let db: NodeDb;
  beforeEach(async () => {
    db = openNodeDb();
    await migrate(db, MIGRATIONS);
  });
  afterEach(() => db.close());

  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));
  const library = (refs: string[]) => refs.map((ref) => audio(ref));

  /** One playlist with every local track, a favourite and a play for each. */
  const collect = async () => {
    await db.run("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (1, 'p', 0, 0)");
    const rows = await db.getAll<{ id: number }>('SELECT id FROM tracks ORDER BY id');
    for (const [position, { id }] of rows.entries()) {
      await db.run(
        'INSERT INTO playlist_items (playlist_id, position, track_id) VALUES (1, ?, ?)',
        [position, id],
      );
      await db.run("INSERT INTO favorites (kind, key, added_at) VALUES ('track', ?, 0)", [
        String(id),
      ]);
      await db.run('INSERT INTO history (track_id, played_at, ms_played) VALUES (?, 0, 1000)', [
        id,
      ]);
    }
  };
  const n = async (sql: string) => (await db.getFirst<{ n: number }>(sql))?.n;
  const counts = async () => ({
    tracks: await countLocalTracks(db),
    items: await n('SELECT COUNT(*) AS n FROM playlist_items'),
    favorites: await n('SELECT COUNT(*) AS n FROM favorites'),
    history: await n('SELECT COUNT(*) AS n FROM history'),
  });

  it('decides when missing tracks look like a storage or permission problem', () => {
    expect(shouldHoldRemovals(3, 0, 3)).toBe(true);
    expect(shouldHoldRemovals(3, 2, 1)).toBe(false);
    expect(shouldHoldRemovals(20, 9, 11)).toBe(true);
    expect(shouldHoldRemovals(20, 10, 10)).toBe(false);
    expect(shouldHoldRemovals(19, 1, 18)).toBe(false);
    expect(shouldHoldRemovals(5, 0, 0)).toBe(false);
  });

  it('keeps everything when the MediaStore returns nothing', async () => {
    await scanLibrary(db, { query: async () => library(ids(3)) });
    await collect();
    const result = await scanLibrary(db, { query: async () => [] });
    expect(result).toMatchObject({ added: 0, removed: 0, held: 3, total: 3 });
    expect(await counts()).toEqual({ tracks: 3, items: 3, favorites: 3, history: 3 });
  });

  it('refuses to remove more than half of 20+ tracks, then removes them once confirmed', async () => {
    await scanLibrary(db, { query: async () => library(ids(20)) });
    await collect();
    // 11 of 20 gone and one new file: the addition is kept, nothing is removed.
    const smaller = library([...ids(9), '99']);
    const held = await scanLibrary(db, { query: async () => smaller });
    expect(held).toMatchObject({ added: 1, removed: 0, held: 11, total: 21 });
    expect(await counts()).toEqual({ tracks: 21, items: 20, favorites: 20, history: 20 });

    const confirmed = await scanLibrary(db, { query: async () => smaller, allowRemovals: true });
    expect(confirmed).toMatchObject({ added: 0, removed: 11, held: 0, total: 10 });
    expect(await counts()).toEqual({ tracks: 10, items: 9, favorites: 9, history: 9 });
  });

  it('still removes a few missing tracks with their playlist entries, favourites and history', async () => {
    await scanLibrary(db, { query: async () => library(ids(20)) });
    await collect();
    const result = await scanLibrary(db, { query: async () => library(ids(10)) });
    expect(result).toMatchObject({ removed: 10, held: 0, total: 10 });
    expect(await counts()).toEqual({ tracks: 10, items: 10, favorites: 10, history: 10 });
  });

  it('does not count tracks in excluded folders as missing', async () => {
    const files = ids(20).map((ref, i) =>
      audio(ref, { folder: i < 12 ? 'Music/Podcasts/' : 'Music/Keep/' }),
    );
    await scanLibrary(db, { query: async () => files });
    const result = await scanLibrary(db, {
      query: async () => files,
      excludedFolders: ['Music/Podcasts/'],
    });
    expect(result).toMatchObject({ removed: 12, held: 0, total: 8 });
  });

  it('still applies a folder exclusion when it holds back missing tracks', async () => {
    const files = ids(24).map((ref, i) =>
      audio(ref, { folder: i < 4 ? 'Music/Podcasts/' : 'Music/Keep/' }),
    );
    await scanLibrary(db, { query: async () => files });
    // 4 excluded files still on the phone, 14 of the other 20 gone (14 of 24 > 50 %).
    const result = await scanLibrary(db, {
      query: async () => files.filter((_, i) => i < 10),
      excludedFolders: ['Music/Podcasts/'],
    });
    expect(result).toMatchObject({ removed: 4, held: 14, total: 20 });
    expect(await countLocalTracks(db)).toBe(20);
  });
});

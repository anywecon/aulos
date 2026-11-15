import { queryAudio, type MediaStoreAudio } from '../../modules/media-store';
import { moveAlbumFavorites, trackFavoriteKey } from '@/collections/favorites';
import type { Db } from '@/db/types';
import { normalizeNullable, normalizeText } from '@/search/normalize';
import {
  diffLocalTracks,
  toGroupedFields,
  toTrackFields,
  type LocalTrackFields,
  type StoredLocalTrack,
} from './diff';
import { albumGroupKeys } from './albumKey';
import { isFolderExcluded } from './folders';
import { LOCAL_PROVIDER } from './providers';

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
  durationMs: number;
  /**
   * Tracks missing from the MediaStore that were kept because the scan looked like a storage or
   * permission problem (see shouldHoldRemovals); 0 or absent when nothing was held back.
   */
  held?: number;
}

export interface ScanOptions {
  query?: () => Promise<MediaStoreAudio[]>;
  now?: () => number;
  /** Folders (and their subfolders) left out of the library. */
  excludedFolders?: readonly string[];
  /** The user confirmed that the missing tracks are really gone: remove them however many. */
  allowRemovals?: boolean;
}

/** Below this many local tracks, a large share going missing is not suspicious. */
export const REMOVAL_GUARD_MIN_TRACKS = 20;
/** More than this share of the local tracks missing in one scan holds every removal back. */
export const REMOVAL_GUARD_SHARE = 0.5;

/**
 * True when tracks missing from the MediaStore should be kept: it returned nothing while the
 * library has local tracks, or more than half of at least 20 local tracks went missing at once.
 * That looks like a revoked permission, an unmounted SD card or a MediaStore rebuilt after an OS
 * update rather than deleted music, and removing them would also remove their playlist entries,
 * favourites and history for good.
 */
export function shouldHoldRemovals(
  storedCount: number,
  mediaStoreCount: number,
  missingCount: number,
): boolean {
  if (missingCount === 0) return false;
  if (mediaStoreCount === 0) return true;
  return (
    storedCount >= REMOVAL_GUARD_MIN_TRACKS && missingCount > storedCount * REMOVAL_GUARD_SHARE
  );
}

async function getStoredLocalTracks(db: Db): Promise<StoredLocalTrack[]> {
  return db.getAll<StoredLocalTrack>(
    `SELECT id, provider_ref AS providerRef, title, artist, album, album_artist AS albumArtist,
            track_no AS trackNo, disc_no AS discNo, duration_ms AS durationMs,
            local_path AS localPath, file_mtime AS fileMtime, file_size AS fileSize, year,
            album_ref AS albumRef, album_key AS albumKey, added_at AS addedAt
       FROM tracks WHERE provider = ?`,
    [LOCAL_PROVIDER],
  );
}

/** The searchable, normalised copies of the tag columns. */
function normColumns(t: LocalTrackFields) {
  return [
    normalizeText(t.title),
    normalizeNullable(t.artist),
    normalizeNullable(t.album),
    normalizeNullable(t.albumArtist),
  ] as const;
}

/**
 * Syncs the 'local' rows of `tracks` with the MediaStore in one transaction:
 * inserts new files, updates changed ones and deletes rows whose file is gone or whose folder
 * is excluded. Rows whose file is gone are kept when shouldHoldRemovals says the scan looks like
 * a storage or permission problem, unless `allowRemovals`. The caller must hold the audio read
 * permission.
 */
export async function scanLibrary(db: Db, options: ScanOptions = {}): Promise<ScanResult> {
  const {
    query = queryAudio,
    now = Date.now,
    excludedFolders = [],
    allowRemovals = false,
  } = options;
  const started = now();
  const all = await query();
  const onDevice = new Set(all.map((a) => a.id));
  const audio = all.filter((a) => !isFolderExcluded(a.folder, excludedFolders));
  const albumKeys = albumGroupKeys(audio.map(toGroupedFields));
  const scanned = audio.map((a, i) => toTrackFields(a, albumKeys[i] ?? null));
  const scannedAt = now();

  const diff = await db.transaction(async (tx) => {
    const stored = await getStoredLocalTracks(tx);
    const result = diffLocalTracks(stored, scanned);
    // Rows in an excluded folder are still on the device: removing them is the user's choice.
    const deleted = new Set(result.toDelete);
    // Rows still on the device (in an excluded folder) are removed by the user's choice; only
    // rows whose file the MediaStore no longer lists count as missing.
    const missing = new Set(
      stored.filter((t) => deleted.has(t.id) && !onDevice.has(t.providerRef)).map((t) => t.id),
    );
    const hold = !allowRemovals && shouldHoldRemovals(stored.length, all.length, missing.size);
    for (const t of result.toInsert) {
      await tx.run(
        `INSERT INTO tracks (provider, provider_ref, title, artist, album, album_artist, track_no,
                             disc_no, duration_ms, local_path, file_mtime, file_size, year, added_at,
                             album_ref, album_key, title_norm, artist_norm, album_norm,
                             album_artist_norm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          LOCAL_PROVIDER,
          t.providerRef,
          t.title,
          t.artist,
          t.album,
          t.albumArtist,
          t.trackNo,
          t.discNo,
          t.durationMs,
          t.localPath,
          t.fileMtime,
          t.fileSize,
          t.year,
          t.addedAt ?? scannedAt,
          t.albumRef,
          t.albumKey,
          ...normColumns(t),
        ],
      );
    }
    for (const t of result.toUpdate) {
      await tx.run(
        `UPDATE tracks SET title = ?, artist = ?, album = ?, album_artist = ?, track_no = ?,
                           disc_no = ?, duration_ms = ?, local_path = ?, file_mtime = ?,
                           file_size = ?, year = ?, album_ref = ?, album_key = ?,
                           title_norm = ?, artist_norm = ?, album_norm = ?, album_artist_norm = ?
          WHERE id = ?`,
        [
          t.title,
          t.artist,
          t.album,
          t.albumArtist,
          t.trackNo,
          t.discNo,
          t.durationMs,
          t.localPath,
          t.fileMtime,
          t.fileSize,
          t.year,
          t.albumRef,
          t.albumKey,
          ...normColumns(t),
          t.id,
        ],
      );
    }
    const toDelete = hold ? result.toDelete.filter((id) => !missing.has(id)) : result.toDelete;
    for (const id of toDelete) {
      await tx.run('DELETE FROM tracks WHERE id = ?', [id]);
      // Track favourites are keyed by id as text (no foreign key), and SQLite reuses the highest
      // freed id: drop the favourite with its track so it never lands on a new one.
      await tx.run("DELETE FROM favorites WHERE kind = 'track' AND key = ?", [
        trackFavoriteKey(id),
      ]);
    }
    const oldKeys = new Map(stored.map((t) => [t.id, t.albumKey]));
    await moveAlbumFavorites(
      tx,
      result.toUpdate.flatMap((t) => {
        const from = oldKeys.get(t.id);
        return from && t.albumKey && from !== t.albumKey ? [{ from, to: t.albumKey }] : [];
      }),
    );
    return { ...result, toDelete, held: hold ? missing.size : 0 };
  });

  return {
    added: diff.toInsert.length,
    updated: diff.toUpdate.length,
    removed: diff.toDelete.length,
    total: diff.total + diff.held,
    durationMs: now() - started,
    held: diff.held,
  };
}

export async function countLocalTracks(db: Db): Promise<number> {
  const row = await db.getFirst<{ n: number }>(
    'SELECT COUNT(*) AS n FROM tracks WHERE provider = ?',
    [LOCAL_PROVIDER],
  );
  return row?.n ?? 0;
}

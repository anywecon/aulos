import type { Db } from '../types';
import type { Migration } from '../migrate';

/**
 * Rows that point at a track id that no longer exists in `tracks`. Rows of tracks that still
 * exist are never touched.
 */
const ORPHANS = {
  playlistItems: 'FROM playlist_items WHERE track_id NOT IN (SELECT id FROM tracks)',
  history: 'FROM history WHERE track_id NOT IN (SELECT id FROM tracks)',
  downloads: 'FROM downloads WHERE track_id NOT IN (SELECT id FROM tracks)',
  trackFavorites:
    "FROM favorites WHERE kind = 'track' AND key NOT IN (SELECT CAST(id AS TEXT) FROM tracks)",
} as const;

export type OrphanCounts = Record<keyof typeof ORPHANS, number>;

/** Deletes the orphan rows and returns how many of each kind there were. */
export async function deleteOrphanRows(tx: Db): Promise<OrphanCounts> {
  const counts = {} as OrphanCounts;
  for (const [kind, where] of Object.entries(ORPHANS) as [keyof typeof ORPHANS, string][]) {
    const row = await tx.getFirst<{ n: number }>(`SELECT COUNT(*) AS n ${where}`);
    counts[kind] = row?.n ?? 0;
    if (counts[kind] > 0) await tx.run(`DELETE ${where}`);
  }
  return counts;
}

/**
 * Removes true orphans. Until 1.0.0, transactions ran on an expo-sqlite connection with foreign
 * keys off, so a scan that deleted tracks left their playlist items, history and download rows
 * behind instead of cascading (see src/db/expo-db.ts); track favourites (keyed by the track id
 * as text, no foreign key) were never removed with their track. On an existing library the
 * counts go to the log (logcat tag ReactNativeJS) so an upgrade check can list them.
 */
export const migration006: Migration = {
  version: 6,
  name: 'orphan_rows',
  sql: '-- data only: see up()',
  async up(tx) {
    const tracks = (await tx.getFirst<{ n: number }>('SELECT COUNT(*) AS n FROM tracks'))?.n ?? 0;
    const counts = await deleteOrphanRows(tx);
    // A fresh install has nothing to report.
    if (tracks > 0 || Object.values(counts).some((c) => c > 0)) {
      console.info(`Aulos migration 006: orphan rows removed ${JSON.stringify(counts)}`);
    }
  },
};

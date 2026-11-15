import type { Migration } from '../migrate';

/**
 * Removes rows whose track no longer exists. Until 1.0.0, transactions ran on an expo-sqlite
 * connection with foreign keys off, so a scan that deleted tracks left their playlist items,
 * history and download rows behind instead of cascading (see src/db/expo-db.ts). Track
 * favourites (keyed by the track id as text, no foreign key) were never removed with their
 * track at all.
 */
export const migration006: Migration = {
  version: 6,
  name: 'orphan_rows',
  sql: `
DELETE FROM playlist_items WHERE track_id NOT IN (SELECT id FROM tracks);
DELETE FROM history WHERE track_id NOT IN (SELECT id FROM tracks);
DELETE FROM downloads WHERE track_id NOT IN (SELECT id FROM tracks);
DELETE FROM favorites WHERE kind = 'track' AND key NOT IN (SELECT CAST(id AS TEXT) FROM tracks);
`,
};

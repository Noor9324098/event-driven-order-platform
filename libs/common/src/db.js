import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Each service owns exactly one database; no service reads another one's. */
export function openDb(file = ':memory:', schema = '') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS processed_events (id TEXT PRIMARY KEY, at TEXT NOT NULL);');
  db.exec(schema);
  return db;
}

/** Runs `fn` inside a transaction. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Idempotent consumer wrapper: an event id is processed at most once per
 * service. If the handler throws, the marker is removed so a redelivery retries.
 */
export function once(db, handler) {
  return async (evt) => {
    const r = db
      .prepare('INSERT OR IGNORE INTO processed_events (id, at) VALUES (?, ?)')
      .run(evt.id, new Date().toISOString());
    if (r.changes === 0) return;
    try {
      await handler(evt);
    } catch (err) {
      db.prepare('DELETE FROM processed_events WHERE id = ?').run(evt.id);
      throw err;
    }
  };
}

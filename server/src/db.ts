/**
 * Local SQLite mirror of your health data.
 *
 * Why mirror at all: the Health API is rate limited, paginated, and range
 * capped, and it only reflects what Google still holds. A local copy makes
 * analysis fast, offline, and durable against the kind of API sunset that just
 * killed the Fitbit Web API.
 *
 * Schema note: rather than modelling ~40 response shapes as ~40 tables, every
 * point lands in one table with the full JSON payload retained verbatim. A
 * best-effort numeric `value` and `day` are extracted for charting. If the
 * extraction is wrong for a type, the raw payload is still there and the
 * normalizer can be fixed without re-syncing.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.ts";

export type DataPointRow = {
  dataType: string;
  pointId: string;
  startTime: string | null;
  endTime: string | null;
  day: string | null;
  value: number | null;
  unit: string | null;
  payload: string;
};

let db: DatabaseSync | null = null;

export function database(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS data_points (
      data_type  TEXT NOT NULL,
      point_id   TEXT NOT NULL,
      start_time TEXT,
      end_time   TEXT,
      day        TEXT,
      value      REAL,
      unit       TEXT,
      payload    TEXT NOT NULL,
      PRIMARY KEY (data_type, point_id)
    );

    CREATE INDEX IF NOT EXISTS idx_points_type_day
      ON data_points (data_type, day);
    CREATE INDEX IF NOT EXISTS idx_points_type_start
      ON data_points (data_type, start_time);

    CREATE TABLE IF NOT EXISTS sync_state (
      data_type       TEXT PRIMARY KEY,
      synced_from     TEXT,
      synced_through  TEXT,
      last_run_at     TEXT,
      last_error      TEXT,
      point_count     INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Inserts or replaces a batch of points in one transaction.
 *
 * Re-syncing an overlapping range is therefore idempotent, which matters
 * because the daily sync deliberately re-fetches recent days: a device that
 * syncs late can backfill points into a window already pulled.
 */
export function upsertPoints(rows: DataPointRow[]): void {
  if (!rows.length) return;
  const d = database();
  const stmt = d.prepare(`
    INSERT INTO data_points
      (data_type, point_id, start_time, end_time, day, value, unit, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (data_type, point_id) DO UPDATE SET
      start_time = excluded.start_time,
      end_time   = excluded.end_time,
      day        = excluded.day,
      value      = excluded.value,
      unit       = excluded.unit,
      payload    = excluded.payload
  `);

  d.exec("BEGIN");
  try {
    for (const r of rows) {
      stmt.run(r.dataType, r.pointId, r.startTime, r.endTime, r.day, r.value, r.unit, r.payload);
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export function recordSync(opts: {
  dataType: string;
  from: Date;
  through: Date;
  error?: string;
}): void {
  const d = database();
  d.prepare(`
    INSERT INTO sync_state (data_type, synced_from, synced_through, last_run_at, last_error, point_count)
    VALUES (?, ?, ?, ?, ?, (SELECT COUNT(*) FROM data_points WHERE data_type = ?))
    ON CONFLICT (data_type) DO UPDATE SET
      synced_from = MIN(COALESCE(sync_state.synced_from, excluded.synced_from), excluded.synced_from),
      synced_through = MAX(COALESCE(sync_state.synced_through, excluded.synced_through), excluded.synced_through),
      last_run_at = excluded.last_run_at,
      last_error = excluded.last_error,
      point_count = excluded.point_count
  `).run(
    opts.dataType,
    opts.from.toISOString(),
    opts.through.toISOString(),
    new Date().toISOString(),
    opts.error ?? null,
    opts.dataType,
  );
}

export type SyncStateRow = {
  data_type: string;
  synced_from: string | null;
  synced_through: string | null;
  last_run_at: string | null;
  last_error: string | null;
  point_count: number;
};

export function syncState(): SyncStateRow[] {
  return database()
    .prepare("SELECT * FROM sync_state ORDER BY data_type")
    .all() as unknown as SyncStateRow[];
}

/** Daily aggregate for charting. `agg` is applied across points within a day. */
export function dailySeries(opts: {
  dataType: string;
  from: string;
  to: string;
  agg: "sum" | "avg" | "min" | "max" | "count";
}): Array<{ day: string; value: number; n: number }> {
  const fn = { sum: "SUM", avg: "AVG", min: "MIN", max: "MAX", count: "COUNT" }[opts.agg];
  return database()
    .prepare(`
      SELECT day, ${fn}(value) AS value, COUNT(*) AS n
      FROM data_points
      WHERE data_type = ? AND day IS NOT NULL AND day >= ? AND day <= ?
        AND (value IS NOT NULL OR ? = 'count')
      GROUP BY day
      ORDER BY day
    `)
    .all(opts.dataType, opts.from, opts.to, opts.agg) as unknown as Array<{
    day: string;
    value: number;
    n: number;
  }>;
}

/** Raw points, newest first, for inspecting real payload shapes. */
export function rawPoints(dataType: string, limit: number): unknown[] {
  const rows = database()
    .prepare(`
      SELECT payload FROM data_points
      WHERE data_type = ?
      ORDER BY COALESCE(start_time, day) DESC
      LIMIT ?
    `)
    .all(dataType, limit) as unknown as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload));
}

export function typeCounts(): Array<{ data_type: string; n: number; first: string; last: string }> {
  return database()
    .prepare(`
      SELECT data_type,
             COUNT(*) AS n,
             MIN(COALESCE(day, start_time)) AS first,
             MAX(COALESCE(day, start_time)) AS last
      FROM data_points
      GROUP BY data_type
      ORDER BY data_type
    `)
    .all() as unknown as Array<{ data_type: string; n: number; first: string; last: string }>;
}

/**
 * Pulls date ranges from the Health API into the local SQLite mirror.
 *
 * Ranges are walked in chunks rather than requested whole: minute-level heart
 * rate over a year is millions of points, and a single unbounded filter is both
 * slow and prone to timing out mid-pagination with nothing persisted. Chunking
 * means a failure costs one window, not the whole backfill.
 */

import { DATA_TYPES, requireType, type DataType } from "./datatypes.ts";
import { listDataPoints } from "./health.ts";
import { normalize } from "./normalize.ts";
import { recordSync, upsertPoints } from "./db.ts";

const DAY_MS = 86_400_000;

/** Days per request window. Sample types are dense, so they get smaller ones. */
function chunkDays(type: DataType): number {
  if (type.timeField === "sample") return 7;
  if (type.smallPageCap) return 30;
  return 30;
}

export type SyncResult = {
  dataType: string;
  label: string;
  points: number;
  error?: string;
};

export type SyncProgress = (msg: string) => void;

export async function syncType(
  type: DataType,
  from: Date,
  to: Date,
  onProgress: SyncProgress = () => {},
): Promise<SyncResult> {
  let points = 0;
  const step = chunkDays(type) * DAY_MS;

  try {
    for (let cursor = from.getTime(); cursor < to.getTime(); cursor += step) {
      const windowStart = new Date(cursor);
      const windowEnd = new Date(Math.min(cursor + step, to.getTime()));

      const n = await listDataPoints(type, windowStart, windowEnd, (batch) => {
        const rows = batch
          .map((raw) => normalize(type, raw))
          .filter((r): r is NonNullable<typeof r> => r !== null);
        upsertPoints(rows);
      });

      points += n;
      onProgress(
        `  ${type.id}: ${windowStart.toISOString().slice(0, 10)} -> ` +
          `${windowEnd.toISOString().slice(0, 10)}  ${n} points`,
      );
    }

    recordSync({ dataType: type.id, from, through: to });
    return { dataType: type.id, label: type.label, points };
  } catch (err) {
    const message = (err as Error).message;
    recordSync({ dataType: type.id, from, through: to, error: message });
    return { dataType: type.id, label: type.label, points, error: message };
  }
}

/**
 * Syncs every registered type. Runs sequentially on purpose: the API is rate
 * limited per user, and parallel type syncs mostly buy 429s.
 */
export async function syncAll(
  from: Date,
  to: Date,
  onProgress: SyncProgress = () => {},
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const type of DATA_TYPES) {
    onProgress(`${type.label} (${type.id})`);
    results.push(await syncType(type, from, to, onProgress));
  }
  return results;
}

export async function syncOne(
  id: string,
  from: Date,
  to: Date,
  onProgress?: SyncProgress,
): Promise<SyncResult> {
  return syncType(requireType(id), from, to, onProgress);
}

/** Midnight UTC `days` ago, as the inclusive start of a backfill. */
export function daysAgo(days: number): Date {
  const d = new Date(Date.now() - days * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Tomorrow midnight UTC: the exclusive upper bound that includes today. */
export function endOfToday(): Date {
  const d = new Date(Date.now() + DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

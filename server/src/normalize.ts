/**
 * Turns a Health API data point into a storable row.
 *
 * Deliberately tolerant. The v4 response schema differs per data type and is
 * not fully documented in public; rather than hard-coding ~40 shapes from
 * guesswork, this walks the object for the conventional field names and falls
 * back to the first plausible numeric leaf. The full payload is always kept, so
 * a wrong guess costs a re-normalize, never a re-sync.
 *
 * Once you have seen real payloads (`pnpm inspect <type>`), tighten the
 * specific types you care about in VALUE_PATHS below.
 */

import { civilDate, type DataType } from "./datatypes.ts";
import type { DataPointRow } from "./db.ts";

type Json = Record<string, unknown>;

/**
 * Explicit value extraction per data type, by dotted path into the payload.
 * Empty until confirmed against real responses - see the module comment.
 * Example once confirmed: "steps": ["steps.count", "count"]
 */
const VALUE_PATHS: Record<string, string[]> = {};

/** Field names that conventionally carry the measurement itself. */
const VALUE_KEYS = [
  "count", "steps", "value", "bpm", "beatsPerMinute",
  "meters", "distanceMeters", "kilocalories", "calories", "energyKilocalories",
  "minutes", "durationMinutes", "percentage", "percent",
  "kilograms", "weightKilograms", "celsius", "milliseconds", "millis",
  "breathsPerMinute", "millilitersPerKgPerMinute", "score",
];

/** Field names that conventionally carry the unit. */
const UNIT_KEYS = ["unit", "units", "unitType"];

export function normalize(type: DataType, raw: unknown): DataPointRow | null {
  if (!isJson(raw)) return null;

  const { start, end } = extractTimes(raw);
  const day = extractDay(raw, start);
  const { value, unit } = extractValue(type, raw);

  return {
    dataType: type.id,
    pointId: pointId(raw, type, start, day),
    startTime: start,
    endTime: end,
    day,
    value,
    unit,
    payload: JSON.stringify(raw),
  };
}

/**
 * A stable identity for the point, so re-syncing an overlapping range updates
 * rather than duplicates. Prefers the API's own id; otherwise derives one from
 * the timestamp, which is unique per point for every type we mirror.
 */
function pointId(raw: Json, type: DataType, start: string | null, day: string | null): string {
  const id = firstString(raw, ["id", "name", "dataPointId", "pointId"]);
  if (id) return id;
  return `${type.id}:${start ?? day ?? JSON.stringify(raw).length}`;
}

function extractTimes(raw: Json): { start: string | null; end: string | null } {
  // Interval types nest under `interval`; sample types use `sampleTime`.
  const interval = asJson(raw.interval);
  if (interval) {
    return {
      start: firstString(interval, ["startTime", "physicalStartTime", "civilStartTime"]),
      end: firstString(interval, ["endTime", "physicalEndTime", "civilEndTime"]),
    };
  }
  const sampleTime = asJson(raw.sampleTime);
  if (sampleTime) {
    const t = firstString(sampleTime, ["physicalTime", "civilTime", "time"]);
    return { start: t, end: t };
  }
  const flat = firstString(raw, ["startTime", "sampleTime", "time", "timestamp"]);
  return { start: flat, end: firstString(raw, ["endTime"]) };
}

function extractDay(raw: Json, start: string | null): string | null {
  // Daily types carry an explicit date, either as a string or a civil-date object.
  const direct = firstString(raw, ["date", "localDate", "civilDate"]);
  if (direct) return direct.slice(0, 10);

  const dateObj = asJson(raw.date);
  if (dateObj && typeof dateObj.year === "number") {
    const y = dateObj.year;
    const m = Number(dateObj.month ?? 1);
    const d = Number(dateObj.day ?? 1);
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  if (start) {
    // Civil times have no zone, so slicing is exactly the local day. Physical
    // times are UTC instants; slicing gives the UTC day, which is the
    // documented tradeoff rather than a silent guess at the wearer's zone.
    const parsed = new Date(start);
    return Number.isNaN(parsed.getTime()) ? start.slice(0, 10) : civilDate(parsed);
  }
  return null;
}

function extractValue(type: DataType, raw: Json): { value: number | null; unit: string | null } {
  for (const path of VALUE_PATHS[type.id] ?? []) {
    const found = atPath(raw, path);
    if (typeof found === "number") return { value: found, unit: findUnit(raw) };
  }

  // Types usually wrap their payload in an object named after themselves,
  // e.g. { steps: { count: 1234 } }. Look there first, then the top level.
  const camel = type.filterName.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const nested = asJson(raw[camel]) ?? asJson(raw[type.filterName]);
  for (const scope of [nested, raw]) {
    if (!scope) continue;
    for (const key of VALUE_KEYS) {
      const v = scope[key];
      if (typeof v === "number") return { value: v, unit: findUnit(scope) ?? findUnit(raw) };
      // Quantities often nest as { value: n, unit: "..." }.
      const q = asJson(v);
      if (q && typeof q.value === "number") {
        return { value: q.value, unit: findUnit(q) ?? findUnit(raw) };
      }
    }
  }

  const fallback = firstNumericLeaf(raw, 0);
  return { value: fallback, unit: findUnit(raw) };
}

/** Depth-first search for a numeric leaf, skipping time and identity fields. */
function firstNumericLeaf(node: Json, depth: number): number | null {
  if (depth > 4) return null;
  for (const [key, val] of Object.entries(node)) {
    if (/time|date|id$|^id|zone|offset|version/i.test(key)) continue;
    if (typeof val === "number") return val;
    const child = asJson(val);
    if (child) {
      const found = firstNumericLeaf(child, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function findUnit(node: Json): string | null {
  return firstString(node, UNIT_KEYS);
}

function atPath(node: Json, path: string): unknown {
  let cur: unknown = node;
  for (const seg of path.split(".")) {
    const asObj = asJson(cur);
    if (!asObj) return undefined;
    cur = asObj[seg];
  }
  return cur;
}

function firstString(node: Json, keys: string[]): string | null {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function isJson(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asJson(v: unknown): Json | null {
  return isJson(v) ? v : null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

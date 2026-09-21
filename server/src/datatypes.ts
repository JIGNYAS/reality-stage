/**
 * Google Health API data type registry.
 *
 * Transcribed from the reference implementation at
 * github.com/Google-Health-API/google-health-cli (pkg/types/registry.go).
 * The caps here are API-enforced, not guesses: exceeding them returns 400.
 */

/** How a type expresses time, which decides its filter expression path. */
export type TimeField =
  /** Spans a range, filtered on `<name>.interval.civil_start_time` (no zone). */
  | "interval"
  /** Instantaneous, filtered on `<name>.sample_time.physical_time` (UTC, Z). */
  | "sample"
  /** Daily summary, filtered on `<name>.date` as YYYY-MM-DD. */
  | "daily";

export type DataType = {
  /** kebab-case id used in the URL path. */
  id: string;
  /** snake_case name used inside filter expressions. */
  filterName: string;
  /** OAuth scope category this type is read under. */
  category: ScopeCategory;
  label: string;
  timeField: TimeField;
  /** The API caps pageSize at 25 for these; everything else allows 10000. */
  smallPageCap?: boolean;
  /** Rollup range cap is 14 days for these, 90 for everything else. */
  shortRollupRange?: boolean;
};

export type ScopeCategory =
  | "activity_and_fitness"
  | "health_metrics_and_measurements"
  | "sleep";

const SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth.";

/** Read-only scope URL for a category. */
export function scopeFor(category: ScopeCategory): string {
  return `${SCOPE_PREFIX}${category}.readonly`;
}

/**
 * The types worth mirroring for a Fitbit Air. This is deliberately a subset of
 * the API's ~40: these are the ones the device actually produces. Adding more
 * is a one-line change, since the sync path is type-agnostic.
 */
export const DATA_TYPES: DataType[] = [
  // --- activity_and_fitness ---
  { id: "steps", filterName: "steps", category: "activity_and_fitness", label: "Steps", timeField: "interval" },
  { id: "distance", filterName: "distance", category: "activity_and_fitness", label: "Distance", timeField: "interval" },
  { id: "floors", filterName: "floors", category: "activity_and_fitness", label: "Floors", timeField: "interval" },
  { id: "heart-rate", filterName: "heart_rate", category: "activity_and_fitness", label: "Heart rate", timeField: "sample", shortRollupRange: true },
  { id: "heart-rate-variability", filterName: "heart_rate_variability", category: "activity_and_fitness", label: "HRV", timeField: "sample" },
  { id: "vo2-max", filterName: "vo2_max", category: "activity_and_fitness", label: "VO2 max", timeField: "sample" },
  { id: "active-zone-minutes", filterName: "active_zone_minutes", category: "activity_and_fitness", label: "Active zone minutes", timeField: "interval" },
  { id: "active-minutes", filterName: "active_minutes", category: "activity_and_fitness", label: "Active minutes", timeField: "interval" },
  { id: "activity-level", filterName: "activity_level", category: "activity_and_fitness", label: "Activity level", timeField: "interval" },
  { id: "active-energy-burned", filterName: "active_energy_burned", category: "activity_and_fitness", label: "Active energy", timeField: "interval" },
  { id: "basal-energy-burned", filterName: "basal_energy_burned", category: "activity_and_fitness", label: "Basal energy", timeField: "interval" },
  { id: "total-calories", filterName: "total_calories", category: "activity_and_fitness", label: "Total calories", timeField: "interval", shortRollupRange: true },
  { id: "sedentary-period", filterName: "sedentary_period", category: "activity_and_fitness", label: "Sedentary periods", timeField: "interval" },
  { id: "exercise", filterName: "exercise", category: "activity_and_fitness", label: "Workouts", timeField: "interval", smallPageCap: true },
  { id: "daily-resting-heart-rate", filterName: "daily_resting_heart_rate", category: "activity_and_fitness", label: "Resting HR (daily)", timeField: "daily" },
  { id: "daily-heart-rate-variability", filterName: "daily_heart_rate_variability", category: "activity_and_fitness", label: "HRV (daily)", timeField: "daily" },
  { id: "daily-vo2-max", filterName: "daily_vo2_max", category: "activity_and_fitness", label: "VO2 max (daily)", timeField: "daily" },
  { id: "daily-heart-rate-zones", filterName: "daily_heart_rate_zones", category: "activity_and_fitness", label: "HR zones (daily)", timeField: "daily" },

  // --- sleep ---
  { id: "sleep", filterName: "sleep", category: "sleep", label: "Sleep", timeField: "interval", smallPageCap: true },
  { id: "daily-sleep-temperature-derivations", filterName: "daily_sleep_temperature_derivations", category: "sleep", label: "Sleep skin temperature", timeField: "daily" },
  { id: "respiratory-rate-sleep-summary", filterName: "respiratory_rate_sleep_summary", category: "sleep", label: "Respiratory rate (sleep)", timeField: "sample" },

  // --- health_metrics_and_measurements ---
  { id: "weight", filterName: "weight", category: "health_metrics_and_measurements", label: "Weight", timeField: "sample" },
  { id: "body-fat", filterName: "body_fat", category: "health_metrics_and_measurements", label: "Body fat", timeField: "sample" },
  { id: "oxygen-saturation", filterName: "oxygen_saturation", category: "health_metrics_and_measurements", label: "SpO2", timeField: "sample" },
  { id: "core-body-temperature", filterName: "core_body_temperature", category: "health_metrics_and_measurements", label: "Core body temperature", timeField: "sample" },
  { id: "daily-oxygen-saturation", filterName: "daily_oxygen_saturation", category: "health_metrics_and_measurements", label: "SpO2 (daily)", timeField: "daily" },
  { id: "daily-respiratory-rate", filterName: "daily_respiratory_rate", category: "health_metrics_and_measurements", label: "Respiratory rate (daily)", timeField: "daily" },
];

export const DATA_TYPES_BY_ID = new Map(DATA_TYPES.map((t) => [t.id, t]));

export function requireType(id: string): DataType {
  const found = DATA_TYPES_BY_ID.get(id);
  if (!found) {
    throw new Error(`Unknown data type '${id}'. Known: ${DATA_TYPES.map((t) => t.id).join(", ")}`);
  }
  return found;
}

/** Every distinct read scope the registry needs. */
export function requiredScopes(): string[] {
  return [...new Set(DATA_TYPES.map((t) => scopeFor(t.category)))];
}

export function maxPageSize(type: DataType): number {
  return type.smallPageCap ? 25 : 10_000;
}

/**
 * Builds the `filter` query parameter for a date range.
 *
 * `from` is inclusive, `to` is exclusive — the API supports `>=` and `<` but
 * never `<=`, so callers wanting a whole day must pass the following midnight.
 *
 * Interval and daily types use civil (zone-less) time so they line up with the
 * wearer's local day; sample types compare against true UTC instants and get a
 * `Z` suffix.
 */
export function buildFilter(type: DataType, from: Date, to: Date): string {
  const field = filterField(type);
  if (type.timeField === "daily") {
    return `${field} >= "${civilDate(from)}" AND ${field} < "${civilDate(to)}"`;
  }
  if (type.timeField === "sample") {
    return `${field} >= "${from.toISOString()}" AND ${field} < "${to.toISOString()}"`;
  }
  return `${field} >= "${civilDateTime(from)}" AND ${field} < "${civilDateTime(to)}"`;
}

function filterField(type: DataType): string {
  switch (type.timeField) {
    case "sample":
      return `${type.filterName}.sample_time.physical_time`;
    case "daily":
      return `${type.filterName}.date`;
    case "interval":
      return `${type.filterName}.interval.civil_start_time`;
  }
}

/** YYYY-MM-DD in UTC terms. */
export function civilDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DDTHH:MM:SS with no zone suffix, as civil-time filters require. */
function civilDateTime(d: Date): string {
  return d.toISOString().slice(0, 19);
}

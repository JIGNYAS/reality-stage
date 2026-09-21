const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8787";

export type ScopeCategory = "activity_and_fitness" | "health_metrics_and_measurements" | "sleep";

export type TypeInfo = {
  id: string;
  label: string;
  category: ScopeCategory;
  timeField: "interval" | "sample" | "daily";
};

export type TypeCount = { data_type: string; n: number; first: string; last: string };

export type SyncStateRow = {
  data_type: string;
  synced_from: string | null;
  synced_through: string | null;
  last_run_at: string | null;
  last_error: string | null;
  point_count: number;
};

export type Status = {
  loggedIn: boolean;
  scopes: string[];
  syncing: boolean;
  types: TypeInfo[];
  counts: TypeCount[];
  syncState: SyncStateRow[];
};

export type Point = { day: string; value: number; n: number };

export type Series = {
  type: string;
  label: string;
  agg: string;
  series: Point[];
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function fetchStatus(): Promise<Status> {
  return get<Status>("/api/status");
}

export function fetchSeries(type: string, days: number): Promise<Series> {
  return get<Series>(`/api/series?type=${encodeURIComponent(type)}&days=${days}`);
}

export function fetchRaw(type: string, limit = 3): Promise<{ type: string; points: unknown[] }> {
  return get(`/api/raw?type=${encodeURIComponent(type)}&limit=${limit}`);
}

export async function runSync(days: number, type?: string): Promise<void> {
  const query = new URLSearchParams({ days: String(days) });
  if (type) query.set("type", type);
  const res = await fetch(`${BASE}/api/sync?${query}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sync failed (${res.status}): ${body || res.statusText}`);
  }
}

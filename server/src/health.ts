/**
 * Thin client for the Google Health API v4.
 *
 * Handles the three things that bite you in practice: token refresh, cursor
 * pagination, and the retry policy for 429/5xx.
 */

import { API_BASE_URL } from "./config.ts";
import { accessToken } from "./oauth.ts";
import { buildFilter, maxPageSize, type DataType } from "./datatypes.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly path: string;

  constructor(status: number, body: string, path: string) {
    super(`Health API ${status} on ${path}: ${truncate(body, 400)}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

const MAX_ATTEMPTS = 5;

async function request(path: string, query: URLSearchParams): Promise<unknown> {
  const url = `${API_BASE_URL}${path}${query.size ? `?${query}` : ""}`;

  for (let attempt = 1; ; attempt++) {
    const token = await accessToken();
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });

    if (res.ok) return res.json();

    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new ApiError(res.status, body, path);
    }

    // Honour Retry-After when the API sends it; otherwise exponential backoff
    // with jitter so parallel type syncs do not resonate.
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 2 ** attempt * 250 + Math.random() * 250;
    await sleep(delay);
  }
}

type ListPage = {
  dataPoints?: unknown[];
  nextPageToken?: string;
};

/**
 * Lists every data point of `type` in `[from, to)`, following pagination to the
 * end. `to` is exclusive: the API supports `>=` and `<` but never `<=`.
 *
 * `onPage` lets the caller persist incrementally rather than buffering a year
 * of minute-level heart rate in memory.
 */
export async function listDataPoints(
  type: DataType,
  from: Date,
  to: Date,
  onPage: (points: unknown[]) => void,
): Promise<number> {
  let pageToken: string | undefined;
  let total = 0;

  do {
    const query = new URLSearchParams({
      filter: buildFilter(type, from, to),
      pageSize: String(maxPageSize(type)),
    });
    if (pageToken) query.set("pageToken", pageToken);

    const page = (await request(
      `/users/me/dataTypes/${type.id}/dataPoints`,
      query,
    )) as ListPage;

    const points = page.dataPoints ?? [];
    if (points.length) {
      onPage(points);
      total += points.length;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return total;
}

/** Fetches a single page, for inspecting raw response shapes. */
export async function sampleDataPoints(
  type: DataType,
  from: Date,
  to: Date,
  limit = 3,
): Promise<unknown[]> {
  const query = new URLSearchParams({
    filter: buildFilter(type, from, to),
    pageSize: String(Math.min(limit, maxPageSize(type))),
  });
  const page = (await request(
    `/users/me/dataTypes/${type.id}/dataPoints`,
    query,
  )) as ListPage;
  return (page.dataPoints ?? []).slice(0, limit);
}

export async function identity(): Promise<unknown> {
  return request("/users/me/identity", new URLSearchParams());
}

export async function profile(): Promise<unknown> {
  return request("/users/me/profile", new URLSearchParams());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

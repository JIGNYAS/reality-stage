/**
 * End-to-end check of the sync pipeline against a mock Health API.
 *
 * Runs without Google credentials: it stands up a fake API on loopback, points
 * the client at it, and asserts that filters, pagination, normalization and
 * storage all behave. Real payload shapes are guesses until you run
 * `pnpm inspect` against the live API, so this pins the mechanics, not the
 * schema.
 *
 * Run with: node --experimental-strip-types src/selftest.ts
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";

// Redirect all state to a scratch dir before importing modules that read config.
const scratch = mkdtempSync(join(tmpdir(), "fitbit-lab-test-"));
process.env.FITBIT_LAB_DATA_DIR = scratch;
process.env.FITBIT_LAB_TOKENS = join(scratch, "tokens.json");

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

// --- Mock API -------------------------------------------------------------

const seenRequests: Array<{ path: string; filter: string; pageSize: string }> = [];
let pagesServed = 0;

const mock = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname.endsWith("/identity")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "users/me", id: "test-user" }));
    return;
  }

  seenRequests.push({
    path: url.pathname,
    filter: url.searchParams.get("filter") ?? "",
    pageSize: url.searchParams.get("pageSize") ?? "",
  });

  // Serve two pages, then stop, to exercise cursor pagination.
  const token = url.searchParams.get("pageToken");
  pagesServed++;
  const base = token === "page2" ? 100 : 0;
  const body: Record<string, unknown> = {
    dataPoints: [
      {
        id: `pt-${base + 1}`,
        interval: { startTime: "2026-09-10T08:00:00Z", endTime: "2026-09-10T09:00:00Z" },
        steps: { count: 1200 + base },
      },
      {
        id: `pt-${base + 2}`,
        interval: { startTime: "2026-09-11T08:00:00Z", endTime: "2026-09-11T09:00:00Z" },
        steps: { count: 800 + base },
      },
    ],
  };
  if (!token) body.nextPageToken = "page2";

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});

await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const port = (mock.address() as AddressInfo).port;
process.env.FITBIT_LAB_API_BASE = `http://127.0.0.1:${port}/v4`;

// Write a token file so the client skips the OAuth flow entirely.
const { writeFileSync } = await import("node:fs");
writeFileSync(
  process.env.FITBIT_LAB_TOKENS,
  JSON.stringify({
    access_token: "fake-token",
    refresh_token: "fake-refresh",
    expires_at: Date.now() + 3_600_000,
    scope: "test",
  }),
);

// --- Imports (after env is set, so config picks up the scratch paths) ------

const { buildFilter, requireType, maxPageSize, requiredScopes } = await import("./datatypes.ts");
const { normalize } = await import("./normalize.ts");
const { syncOne } = await import("./sync.ts");
const { dailySeries, typeCounts, syncState } = await import("./db.ts");

console.log("\nfilter construction");

check("interval types use zone-less civil time", () => {
  const f = buildFilter(requireType("steps"), new Date("2026-09-01T00:00:00Z"), new Date("2026-09-08T00:00:00Z"));
  assert.equal(f, 'steps.interval.civil_start_time >= "2026-09-01T00:00:00" AND steps.interval.civil_start_time < "2026-09-08T00:00:00"');
  assert.ok(!f.includes("Z"), "civil time must not carry a zone suffix");
});

check("sample types use UTC physical time with Z", () => {
  const f = buildFilter(requireType("heart-rate"), new Date("2026-09-01T00:00:00Z"), new Date("2026-09-08T00:00:00Z"));
  assert.equal(f, 'heart_rate.sample_time.physical_time >= "2026-09-01T00:00:00.000Z" AND heart_rate.sample_time.physical_time < "2026-09-08T00:00:00.000Z"');
});

check("daily types filter on a bare date", () => {
  const f = buildFilter(requireType("daily-resting-heart-rate"), new Date("2026-09-01T00:00:00Z"), new Date("2026-09-08T00:00:00Z"));
  assert.equal(f, 'daily_resting_heart_rate.date >= "2026-09-01" AND daily_resting_heart_rate.date < "2026-09-08"');
});

check("page size caps match the API (25 for sleep/exercise, 10000 otherwise)", () => {
  assert.equal(maxPageSize(requireType("sleep")), 25);
  assert.equal(maxPageSize(requireType("exercise")), 25);
  assert.equal(maxPageSize(requireType("steps")), 10_000);
});

check("all three read scopes are requested", () => {
  const scopes = requiredScopes();
  assert.equal(scopes.length, 3);
  for (const s of scopes) assert.ok(s.endsWith(".readonly"), `${s} should be read-only`);
});

console.log("\nnormalization");

check("extracts nested value, times and day from an interval point", () => {
  const row = normalize(requireType("steps"), {
    id: "abc",
    interval: { startTime: "2026-09-10T08:00:00Z", endTime: "2026-09-10T09:00:00Z" },
    steps: { count: 1234 },
  });
  assert.ok(row);
  assert.equal(row.pointId, "abc");
  assert.equal(row.value, 1234);
  assert.equal(row.day, "2026-09-10");
  assert.equal(row.startTime, "2026-09-10T08:00:00Z");
});

check("extracts a sample point with a quantity wrapper", () => {
  const row = normalize(requireType("heart-rate"), {
    id: "hr1",
    sampleTime: { physicalTime: "2026-09-10T08:30:00Z" },
    heartRate: { bpm: 62 },
  });
  assert.ok(row);
  assert.equal(row.value, 62);
  assert.equal(row.day, "2026-09-10");
});

check("extracts a daily point from a structured civil date", () => {
  const row = normalize(requireType("daily-resting-heart-rate"), {
    id: "d1",
    date: { year: 2026, month: 9, day: 7 },
    dailyRestingHeartRate: { bpm: 55 },
  });
  assert.ok(row);
  assert.equal(row.day, "2026-09-07");
  assert.equal(row.value, 55);
});

check("falls back to a numeric leaf for an unrecognized shape", () => {
  const row = normalize(requireType("vo2-max"), {
    id: "v1",
    sampleTime: { physicalTime: "2026-09-10T08:00:00Z" },
    somethingUnexpected: { nested: { reading: 48.5 } },
  });
  assert.ok(row);
  assert.equal(row.value, 48.5, "should find the numeric leaf");
});

check("never loses the raw payload", () => {
  const original = { id: "x", weird: true, interval: { startTime: "2026-09-10T00:00:00Z" }, deep: { a: [1, 2, 3] } };
  const row = normalize(requireType("steps"), original);
  assert.ok(row);
  assert.deepEqual(JSON.parse(row.payload), original);
});

check("synthesizes a stable id when the API omits one", () => {
  const point = { interval: { startTime: "2026-09-10T08:00:00Z" }, steps: { count: 10 } };
  const a = normalize(requireType("steps"), point);
  const b = normalize(requireType("steps"), point);
  assert.ok(a && b);
  assert.equal(a.pointId, b.pointId, "same point must yield the same id, or re-sync duplicates");
});

console.log("\nsync against the mock API");

const result = await syncOne("steps", new Date("2026-09-10T00:00:00Z"), new Date("2026-09-12T00:00:00Z"));

check("sync succeeded", () => {
  assert.equal(result.error, undefined, result.error ?? "");
});

check("followed pagination to the end", () => {
  assert.equal(pagesServed, 2, "should have fetched both pages");
  assert.equal(result.points, 4, "should have collected points from both pages");
});

check("sent the right path, filter and page size", () => {
  const first = seenRequests[0];
  assert.ok(first);
  assert.equal(first.path, "/v4/users/me/dataTypes/steps/dataPoints");
  assert.ok(first.filter.startsWith("steps.interval.civil_start_time >="), first.filter);
  assert.equal(first.pageSize, "10000");
});

check("persisted points to SQLite", () => {
  const counts = typeCounts();
  const steps = counts.find((c) => c.data_type === "steps");
  assert.ok(steps, "steps should be in the local mirror");
  assert.equal(steps.n, 4);
});

check("aggregates into a daily series", () => {
  const series = dailySeries({ dataType: "steps", from: "2026-09-01", to: "2026-09-30", agg: "sum" });
  assert.equal(series.length, 2, "two distinct days");
  assert.equal(series[0]?.day, "2026-09-10");
  assert.equal(series[0]?.value, 1200 + 1300, "both pages' points for day one are summed");
});

check("recorded sync state", () => {
  const state = syncState().find((s) => s.data_type === "steps");
  assert.ok(state);
  assert.equal(state.last_error, null);
  assert.equal(state.point_count, 4);
});

console.log("\nidempotency");

const before = typeCounts().find((c) => c.data_type === "steps")?.n;
await syncOne("steps", new Date("2026-09-10T00:00:00Z"), new Date("2026-09-12T00:00:00Z"));
check("re-syncing the same range updates rather than duplicates", () => {
  const after = typeCounts().find((c) => c.data_type === "steps")?.n;
  assert.equal(after, before, "row count must not grow on re-sync");
});

// --- Teardown -------------------------------------------------------------

mock.close();
rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(failures ? 1 : 0);

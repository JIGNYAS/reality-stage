/**
 * Local HTTP API for the dashboard.
 *
 * Binds to 127.0.0.1 only. It serves your health data with no authentication,
 * which is fine on loopback and would not be fine anywhere else.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SERVER_PORT } from "./config.ts";
import { DATA_TYPES, requireType } from "./datatypes.ts";
import { dailySeries, rawPoints, syncState, typeCounts } from "./db.ts";
import { grantedScopes, isLoggedIn } from "./oauth.ts";
import { daysAgo, endOfToday, syncAll, syncOne } from "./sync.ts";

/** Guards against concurrent syncs, which would just race each other into 429s. */
let syncing = false;

const server = createServer((req, res) => {
  void handle(req, res).catch((err: Error) => {
    send(res, 500, { error: err.message });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${SERVER_PORT}`);

  // The dashboard runs on Vite's port, so loopback CORS is required.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  switch (url.pathname) {
    case "/api/status":
      return send(res, 200, {
        loggedIn: await isLoggedIn(),
        scopes: await grantedScopes(),
        syncing,
        types: DATA_TYPES.map((t) => ({
          id: t.id,
          label: t.label,
          category: t.category,
          timeField: t.timeField,
        })),
        counts: typeCounts(),
        syncState: syncState(),
      });

    case "/api/series": {
      const type = requireType(url.searchParams.get("type") ?? "steps");
      const days = Number(url.searchParams.get("days") ?? 30);
      const agg = (url.searchParams.get("agg") ?? defaultAgg(type.id)) as
        | "sum" | "avg" | "min" | "max" | "count";
      return send(res, 200, {
        type: type.id,
        label: type.label,
        agg,
        series: dailySeries({
          dataType: type.id,
          from: daysAgo(days).toISOString().slice(0, 10),
          to: endOfToday().toISOString().slice(0, 10),
          agg,
        }),
      });
    }

    case "/api/raw": {
      const type = requireType(url.searchParams.get("type") ?? "steps");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 3), 50);
      return send(res, 200, { type: type.id, points: rawPoints(type.id, limit) });
    }

    case "/api/sync": {
      if (req.method !== "POST") return send(res, 405, { error: "POST required" });
      if (syncing) return send(res, 409, { error: "A sync is already running" });

      const days = Number(url.searchParams.get("days") ?? 30);
      const only = url.searchParams.get("type");
      syncing = true;
      try {
        const from = daysAgo(days);
        const to = endOfToday();
        const results = only
          ? [await syncOne(only, from, to)]
          : await syncAll(from, to);
        return send(res, 200, { results });
      } finally {
        syncing = false;
      }
    }

    default:
      return send(res, 404, { error: `No route ${url.pathname}` });
  }
}

/** Summing minute-level heart rate would be meaningless; average it instead. */
function defaultAgg(typeId: string): "sum" | "avg" {
  const averaged = [
    "heart-rate", "heart-rate-variability", "vo2-max", "weight", "body-fat",
    "oxygen-saturation", "core-body-temperature", "daily-resting-heart-rate",
    "daily-heart-rate-variability", "daily-oxygen-saturation",
    "daily-respiratory-rate", "daily-vo2-max", "respiratory-rate-sleep-summary",
    "daily-sleep-temperature-derivations",
  ];
  return averaged.includes(typeId) ? "avg" : "sum";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

server.listen(SERVER_PORT, "127.0.0.1", () => {
  console.log(`fitbit-lab API on http://127.0.0.1:${SERVER_PORT}`);
});

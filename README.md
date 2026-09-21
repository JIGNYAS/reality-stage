# fitbit-lab

Your Fitbit Air data, pulled from the Google Health API into a local SQLite
mirror you own, with a dashboard on top.

Everything runs on your machine. No server, no third party, no upload.

---

## Why this exists, and why not the Fitbit API

**The Fitbit Web API shut down on 30 September 2026.** It is gone, new developer
registrations closed before it, and nothing built on `api.fitbit.com` works any
more. Cloud access to Fitbit data now goes through the **Google Health API**
(GA since May 2026, Google OAuth, completely different data model). This project
targets the Google Health API only.

That sunset is also the argument for the local mirror. An API you do not control
can be withdrawn with a year's notice; a SQLite file on your disk cannot.

## What you get

| Piece | What it does |
|---|---|
| `pnpm login` | Loopback + PKCE OAuth against your own Google account |
| `pnpm sync` | Mirrors date ranges into `data/health.db` |
| `pnpm inspect <type>` | Prints a raw API payload, for finding real response shapes |
| `pnpm server` | Local read API on `127.0.0.1:8787` |
| `pnpm web` | Dashboard on `127.0.0.1:5173` |
| `pnpm test` | End-to-end checks against a mock API, no credentials needed |

27 data types are mirrored, covering what a Fitbit Air produces: steps,
distance, floors, heart rate, HRV, VO2 max, active zone minutes, energy burned,
sleep and sleep skin temperature, SpO2, respiratory rate, weight, body fat, and
the daily-summary variants.

---

## Setup

### 1. Get OAuth credentials

The Health API's scopes are **Restricted**. Production access needs a Google
privacy and security review, but personal use does not: you authorize your own
Cloud project against your own account.

1. Open <https://console.cloud.google.com/apis/credentials>
2. Create or select a project
3. Enable the Health API:
   <https://console.cloud.google.com/apis/api/health.googleapis.com>
4. Create an **OAuth client ID** with application type **Desktop app**
5. On the OAuth consent screen, add your own Google account as a **Test user**
6. Download the client secret JSON to `client_secret.json` in this repo root

> **Desktop app, not Web application.** A Web client requires a real client
> secret for the token exchange, which cannot live safely in a browser, and
> Google will not issue refresh tokens without it. The Desktop flow uses PKCE
> instead, so the "secret" is not security-critical and refresh tokens work.
> This is the same client type Google's own `ghealth` CLI registers as.

### 2. Authorize and sync

```bash
pnpm install
pnpm login                 # opens a consent URL, listens on a loopback port
pnpm sync --days 90        # mirror the last 90 days
pnpm dev                   # server + dashboard together
```

Then open <http://127.0.0.1:5173>.

To pull a single type, or backfill further:

```bash
pnpm sync --type sleep --days 365
```

---

## How it works

```
Google Health API  ──►  server/src/health.ts   pagination, retry, backoff
                        server/src/normalize.ts  payload ──► row
                        server/src/db.ts         SQLite mirror
                              │
                        server/src/index.ts   localhost read API
                              │
                        web/                  dashboard
```

### The API details that actually bite

These are transcribed from Google's reference implementation, not guessed. They
are in `server/src/datatypes.ts`:

- **Base URL** is `https://health.googleapis.com/v4`, and points live at
  `/users/me/dataTypes/{type}/dataPoints`.
- **Filter syntax differs by time field.** Interval types filter on
  `steps.interval.civil_start_time` using *zone-less* civil time. Sample types
  filter on `heart_rate.sample_time.physical_time` using UTC instants with a
  `Z`. Daily summaries filter on `daily_resting_heart_rate.date` as
  `YYYY-MM-DD`. Sending the wrong form is a 400.
- **Ranges are half-open.** The API supports `>=` and `<`, never `<=`. To
  include a whole day you must pass the following midnight as the upper bound.
- **`pageSize` caps at 25 for `sleep` and `exercise`**, 10000 for everything
  else.
- **Rollup ranges cap at 14 days** for `heart-rate`, `total-calories`,
  `active-minutes` and `calories-in-heart-rate-zone`; 90 days for the rest.
- **ECG rejects end-time filters** entirely, and only accepts a lower bound.

### Storage model

One table, `data_points`, holds every type, with the **full JSON payload kept
verbatim** alongside a best-effort numeric `value` and `day` extracted for
charting.

This is deliberate. The v4 per-type response schema is not fully public, so
`normalize.ts` walks each payload for conventional field names rather than
hard-coding 27 shapes from guesswork. Because the raw payload is always
retained, a wrong guess costs a re-normalize, never a re-sync.

**When you have real data, tighten it.** Run `pnpm inspect steps`, or hit
*Inspect payload* in the dashboard, look at the actual shape, and add an entry
to `VALUE_PATHS` in `server/src/normalize.ts`. That is the part of this project
that is genuinely reverse engineering, and it is the part you should expect to
do yourself.

Re-syncing an overlapping range is idempotent, which matters: a device that
syncs late backfills points into a window you already pulled.

---

## Testing

```bash
pnpm test
```

19 checks run against a mock Health API on loopback: filter construction for all
three time fields, page-size caps, scope coverage, payload normalization
including the unknown-shape fallback, cursor pagination, SQLite persistence,
daily aggregation, and re-sync idempotency. No Google credentials required.

To work on the UI without burning API quota:

```bash
node --experimental-sqlite --experimental-strip-types server/src/seed.ts
```

---

## Security notes

- `tokens.json` lives in `~/.config/fitbit-lab/` with mode `0600`. It grants
  read access to your health history.
- `client_secret.json`, `data/`, and `tokens.json` are all gitignored. Keep them
  that way.
- The local API on port 8787 has **no authentication** and serves your health
  data to anything that can reach it. It binds to `127.0.0.1` only. Do not
  expose it.
- Scopes requested are read-only (`.readonly` suffix on all three categories).
  Nothing here can write to or delete your Google health data.

---

## Where this could go next

- **Analysis the Fitbit app will not do for you.** Sleep debt against resting
  HR, HRV trend versus training load, correlations across metrics the official
  app keeps in separate silos.
- **Full history via Google Takeout.** The API is the live feed; Takeout is the
  archive. A Takeout importer writing into the same `data_points` table would
  give you years instead of months.
- **Webhooks** instead of polling. The API supports push subscriptions, which
  needs a `cloud-platform` scope and a reachable endpoint.
- **BLE.** Talking to the device directly, with no Google in the path, is a
  genuinely open problem. Gadgetbridge's Fitbit work gets through pairing and
  the CoAP onboarding sequence but stalls on the `/sync/response` body, which
  appears to need a server-side secret. Prior art worth reading: "Breaking
  Fitness Records Without Moving" (Edinburgh) and Classen & Wegemer's ReCon
  2018 firmware talk.

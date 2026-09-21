/**
 * Command line entry point: `login`, `sync`, `inspect`.
 *
 * `inspect` exists because the v4 response schema is not fully public. Dump a
 * real payload for a type, then tighten VALUE_PATHS in normalize.ts to match.
 */

import { requiredScopes, requireType } from "./datatypes.ts";
import { AuthError, grantedScopes, isLoggedIn, login } from "./oauth.ts";
import { identity, sampleDataPoints } from "./health.ts";
import { daysAgo, endOfToday, syncAll, syncOne } from "./sync.ts";
import { typeCounts } from "./db.ts";

const [, , command, ...args] = process.argv;

try {
  await main(command, args);
} catch (err) {
  if (err instanceof AuthError) {
    console.error(`\n${err.message}\n`);
    if (err.steps.length) {
      console.error("To fix:");
      err.steps.forEach((s, i) => console.error(`  ${i + 1}. ${s}`));
      console.error("");
    }
    process.exit(2);
  }
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}

async function main(cmd: string | undefined, argv: string[]): Promise<void> {
  switch (cmd) {
    case "login":
      return doLogin();
    case "sync":
      return doSync(argv);
    case "inspect":
      return doInspect(argv);
    default:
      console.log(`fitbit-lab

  pnpm login                    Authorize against your own Google account
  pnpm sync [--days N] [--type T]   Mirror data into local SQLite (default 30 days)
  pnpm inspect <type> [--days N]    Print a raw API payload for one type
  pnpm server                   Start the local API for the dashboard
  pnpm web                      Start the dashboard
`);
      process.exit(cmd ? 1 : 0);
  }
}

async function doLogin(): Promise<void> {
  const scopes = requiredScopes();
  console.log("Requesting read-only scopes:");
  scopes.forEach((s) => console.log(`  ${s.replace("https://www.googleapis.com/auth/", "")}`));
  await login(scopes);
  console.log("\nAuthorized. Verifying with a live call...");
  try {
    await identity();
    console.log("Health API reachable. Next: pnpm sync --days 30");
  } catch (err) {
    console.log(`Tokens saved, but the first API call failed:\n  ${(err as Error).message}`);
    console.log("\nIf this is a 403, the Health API may not be enabled on your Cloud project yet.");
  }
}

async function doSync(argv: string[]): Promise<void> {
  await requireLogin();
  const days = Number(flag(argv, "--days") ?? 30);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");

  const from = daysAgo(days);
  const to = endOfToday();
  const only = flag(argv, "--type");

  console.log(
    `Syncing ${only ?? "all types"} from ${from.toISOString().slice(0, 10)} ` +
      `to ${to.toISOString().slice(0, 10)}\n`,
  );

  const results = only
    ? [await syncOne(only, from, to, log)]
    : await syncAll(from, to, log);

  console.log("\nSummary");
  let failed = 0;
  for (const r of results) {
    if (r.error) {
      failed++;
      console.log(`  ${r.dataType.padEnd(36)} FAILED  ${truncate(r.error, 90)}`);
    } else {
      console.log(`  ${r.dataType.padEnd(36)} ${String(r.points).padStart(7)} points`);
    }
  }

  const total = results.reduce((sum, r) => sum + r.points, 0);
  console.log(`\n${total} points stored. ${failed ? `${failed} type(s) failed.` : ""}`);
  if (failed) {
    console.log(
      "A 403 on a type usually means its scope was not granted - re-run `pnpm login`.\n" +
        "A 400 usually means that type's filter shape differs; check normalize.ts.",
    );
  }
}

async function doInspect(argv: string[]): Promise<void> {
  await requireLogin();
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) throw new Error("Usage: pnpm inspect <data-type> [--days N]");

  const type = requireType(id);
  const days = Number(flag(argv, "--days") ?? 7);
  const points = await sampleDataPoints(type, daysAgo(days), endOfToday(), 3);

  if (!points.length) {
    console.log(`No ${type.id} points in the last ${days} days.`);
    const counts = typeCounts().find((c) => c.data_type === type.id);
    if (counts) console.log(`Locally stored: ${counts.n} (${counts.first} .. ${counts.last})`);
    return;
  }
  console.log(JSON.stringify(points, null, 2));
}

async function requireLogin(): Promise<void> {
  if (!(await isLoggedIn())) {
    throw new AuthError("Not logged in. Run `pnpm login` first.");
  }
  const granted = await grantedScopes();
  const missing = requiredScopes().filter((s) => !granted.includes(s));
  if (missing.length) {
    console.warn(
      `Warning: these scopes were not granted, so their types will 403:\n` +
        missing.map((s) => `  ${s}`).join("\n") +
        `\nRe-run \`pnpm login\` to grant them.\n`,
    );
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function log(msg: string): void {
  console.log(msg);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchRaw, fetchSeries, fetchStatus, runSync,
  type Point, type Series, type Status, type TypeInfo,
} from "./api";
import { BarChart, LineChart, Sparkline, formatValue } from "./charts";

/**
 * Colour encodes the OAuth scope category, which is a real property of the
 * data, not decoration. Three values only: the first three categorical slots,
 * which validate all-pairs in both light and dark.
 */
const CATEGORY_COLOR: Record<string, string> = {
  activity_and_fitness: "var(--series-1)",
  health_metrics_and_measurements: "var(--series-2)",
  sleep: "var(--series-3)",
};

const CATEGORY_LABEL: Record<string, string> = {
  activity_and_fitness: "Activity & fitness",
  health_metrics_and_measurements: "Health metrics",
  sleep: "Sleep",
};

/** Types better read as totals per day than as a trend line. */
const BAR_TYPES = new Set([
  "steps", "distance", "floors", "active-zone-minutes", "active-minutes",
  "active-energy-burned", "basal-energy-burned", "total-calories", "exercise",
]);

const RANGES = [7, 30, 90, 365];

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [selected, setSelected] = useState<string>("steps");
  const [series, setSeries] = useState<Series | null>(null);
  const [overview, setOverview] = useState<Record<string, Point[]>>({});
  const [syncing, setSyncing] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [raw, setRaw] = useState<unknown[] | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await fetchStatus());
      setError(null);
    } catch (err) {
      setError(
        `Cannot reach the local API. Start it with \`pnpm server\`. (${(err as Error).message})`,
      );
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /** Types that actually have stored points; nothing else is worth charting. */
  const populated = useMemo(() => {
    if (!status) return [];
    const withData = new Set(status.counts.filter((c) => c.n > 0).map((c) => c.data_type));
    return status.types.filter((t) => withData.has(t.id));
  }, [status]);

  useEffect(() => {
    if (!populated.length) return;
    // If the selection has no data, fall back to the first type that does.
    if (!populated.some((t) => t.id === selected)) {
      setSelected(populated[0]!.id);
    }
  }, [populated, selected]);

  useEffect(() => {
    let cancelled = false;
    fetchSeries(selected, days)
      .then((s) => !cancelled && setSeries(s))
      .catch(() => !cancelled && setSeries(null));
    setRaw(null);
    return () => { cancelled = true; };
  }, [selected, days]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        populated.map(async (t) => {
          try {
            const s = await fetchSeries(t.id, days);
            return [t.id, s.series] as const;
          } catch {
            return [t.id, [] as Point[]] as const;
          }
        }),
      );
      if (!cancelled) setOverview(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [populated, days]);

  const doSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await runSync(days);
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const selectedType = status?.types.find((t) => t.id === selected);
  const color = selectedType ? CATEGORY_COLOR[selectedType.category]! : "var(--series-1)";
  const points = series?.series ?? [];
  const Chart = BAR_TYPES.has(selected) ? BarChart : LineChart;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>fitbit-lab</h1>
          <p className="subtitle">
            Your Fitbit Air data, pulled from the Google Health API into a local
            SQLite mirror you own.
          </p>
        </div>
        <div className="header-actions">
          <div className="range" role="group" aria-label="Time range">
            {RANGES.map((d) => (
              <button
                key={d}
                type="button"
                className={d === days ? "range-btn is-active" : "range-btn"}
                onClick={() => setDays(d)}
              >
                {d === 365 ? "1y" : `${d}d`}
              </button>
            ))}
          </div>
          <button type="button" className="primary" onClick={doSync} disabled={syncing}>
            {syncing ? "Syncing..." : `Sync ${days}d`}
          </button>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}

      {status && !status.loggedIn && (
        <div className="banner">
          Not authorized yet. Run <code>pnpm login</code> in the terminal to
          connect your Google account.
        </div>
      )}

      {status?.loggedIn && !populated.length && !error && (
        <div className="banner">
          Authorized, but nothing is stored locally yet. Run{" "}
          <code>pnpm sync --days 30</code>, or press Sync above.
        </div>
      )}

      {!!populated.length && (
        <>
          <StatTiles types={populated} overview={overview} />

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>{selectedType?.label ?? selected}</h2>
                <p className="panel-sub">
                  {series?.agg === "avg" ? "Daily average" : "Daily total"} ·{" "}
                  {CATEGORY_LABEL[selectedType?.category ?? ""] ?? ""} ·{" "}
                  <code>{selected}</code>
                </p>
              </div>
              <div className="panel-actions">
                <button type="button" className="ghost" onClick={() => setShowTable((v) => !v)}>
                  {showTable ? "Show chart" : "Show table"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={async () => setRaw((await fetchRaw(selected, 2)).points)}
                >
                  Inspect payload
                </button>
              </div>
            </div>

            {showTable ? (
              <DataTable points={points} label={selectedType?.label ?? selected} />
            ) : (
              <Chart points={points} color={color} />
            )}

            {raw && (
              <details className="raw" open>
                <summary>
                  Raw API payload - the ground truth behind the chart. Use this to
                  tighten <code>normalize.ts</code> for this type.
                </summary>
                <pre>{JSON.stringify(raw, null, 2)}</pre>
              </details>
            )}
          </section>

          <section>
            <div className="legend" role="list">
              {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
                <span className="legend-item" role="listitem" key={key}>
                  <span className="swatch" style={{ background: CATEGORY_COLOR[key] }} />
                  {label}
                </span>
              ))}
            </div>

            <div className="grid">
              {populated.map((t) => (
                <MetricCard
                  key={t.id}
                  type={t}
                  points={overview[t.id] ?? []}
                  isActive={t.id === selected}
                  onSelect={() => { setSelected(t.id); setShowTable(false); }}
                />
              ))}
            </div>
          </section>
        </>
      )}

      {status && <SyncLog status={status} />}
    </div>
  );
}

function StatTiles({
  types, overview,
}: { types: TypeInfo[]; overview: Record<string, Point[]> }) {
  const featured = ["steps", "daily-resting-heart-rate", "sleep", "active-zone-minutes"]
    .map((id) => types.find((t) => t.id === id))
    .filter((t): t is TypeInfo => Boolean(t));

  if (!featured.length) return null;

  return (
    <section className="tiles">
      {featured.map((t) => {
        const points = overview[t.id] ?? [];
        const latest = points.at(-1);
        const mean = points.length
          ? points.reduce((s, p) => s + p.value, 0) / points.length
          : 0;
        const delta = latest && mean ? ((latest.value - mean) / mean) * 100 : 0;

        return (
          <div className="tile" key={t.id}>
            <span className="tile-label">{t.label}</span>
            <span className="tile-value">
              {latest ? formatValue(latest.value) : "-"}
            </span>
            <span className="tile-meta">
              {latest ? (
                <>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(0)}% vs {formatValue(mean)} avg
                </>
              ) : (
                "no data"
              )}
            </span>
            <Sparkline points={points} color={CATEGORY_COLOR[t.category]!} />
          </div>
        );
      })}
    </section>
  );
}

function MetricCard({
  type, points, isActive, onSelect,
}: { type: TypeInfo; points: Point[]; isActive: boolean; onSelect: () => void }) {
  const latest = points.at(-1);
  return (
    <button
      type="button"
      className={isActive ? "card is-active" : "card"}
      onClick={onSelect}
      aria-pressed={isActive}
    >
      <span className="card-head">
        <span className="swatch" style={{ background: CATEGORY_COLOR[type.category] }} />
        <span className="card-label">{type.label}</span>
      </span>
      {/* Direct label: required relief for the low-contrast slot on light. */}
      <span className="card-value">{latest ? formatValue(latest.value) : "-"}</span>
      <Sparkline points={points} color={CATEGORY_COLOR[type.category]!} />
      <span className="card-meta">{points.length} days</span>
    </button>
  );
}

function DataTable({ points, label }: { points: Point[]; label: string }) {
  if (!points.length) return <p className="empty">No data in this range.</p>;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{label} by day</caption>
        <thead>
          <tr><th scope="col">Day</th><th scope="col">Value</th><th scope="col">Points</th></tr>
        </thead>
        <tbody>
          {[...points].reverse().map((p) => (
            <tr key={p.day}>
              <td>{p.day}</td>
              <td className="num">{formatValue(p.value)}</td>
              <td className="num">{p.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SyncLog({ status }: { status: Status }) {
  const failed = status.syncState.filter((s) => s.last_error);
  if (!failed.length) return null;
  return (
    <section className="panel">
      <h2>Types that failed to sync</h2>
      <p className="panel-sub">
        A 403 means the scope was not granted; a 400 usually means that type's
        filter or payload shape differs from the registry.
      </p>
      <ul className="fail-list">
        {failed.map((s) => (
          <li key={s.data_type}>
            <code>{s.data_type}</code>
            <span>{s.last_error}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

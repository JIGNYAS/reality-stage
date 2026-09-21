/**
 * Chart primitives, hand-rolled in SVG.
 *
 * No chart library on purpose: the mark specs here (2px lines, 4px rounded bar
 * ends anchored to the baseline, recessive gridlines, crosshair tooltips) are
 * easier to get exactly right in raw SVG than to fight a library's defaults
 * into.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { Point } from "./api";

type Geometry = {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
};

const DEFAULT_GEOM: Geometry = {
  width: 720,
  height: 220,
  padLeft: 48,
  padRight: 16,
  padTop: 16,
  padBottom: 28,
};

/**
 * @param zeroBased Bars encode magnitude by length, so their scale must start
 *   at zero - a truncated bar baseline misstates every comparison on the chart.
 *   Lines encode position, so they may start at a non-zero floor to show
 *   variation that would otherwise be a flat band.
 */
function scales(points: Point[], geom: Geometry, zeroBased: boolean) {
  const plotW = geom.width - geom.padLeft - geom.padRight;
  const plotH = geom.height - geom.padTop - geom.padBottom;

  const values = points.map((p) => p.value);
  const rawMax = values.length ? Math.max(...values) : 1;
  const rawMin = values.length ? Math.min(...values) : 0;

  const { min, max, step } = niceScale(rawMin, rawMax, zeroBased);

  const x = (i: number) =>
    geom.padLeft + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) =>
    geom.padTop + plotH - ((v - min) / (max - min || 1)) * plotH;

  const ticks: number[] = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Number(t.toFixed(6)));

  return { x, y, min, max, ticks, plotW, plotH };
}

/**
 * Picks round axis bounds and a round tick step, targeting ~4 intervals.
 * Snapping the step to 1/2/2.5/5 x a power of ten is what keeps the axis from
 * jumping to the next order of magnitude (145k topping out at 200k instead of
 * a tight 150k).
 */
function niceScale(rawMin: number, rawMax: number, zeroBased: boolean) {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return { min: 0, max: 1, step: 0.5 };

  // A line whose values sit well above zero gets a floor, so variation reads.
  const floorIsZero = zeroBased || rawMin < 0 || rawMin / rawMax <= 0.4;
  const lo = floorIsZero ? 0 : rawMin;
  const span = rawMax - lo || rawMax;

  const step = niceNum(span / 4);
  const min = floorIsZero ? 0 : Math.floor(lo / step) * step;
  const max = Math.ceil(rawMax / step) * step;
  return { min, max, step };
}

function niceNum(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const snapped = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return snapped * mag;
}

export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "-";
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  if (Math.abs(v) >= 100) return String(Math.round(v));
  if (Math.abs(v) >= 10) return v.toFixed(1).replace(/\.0$/, "");
  return v.toFixed(2).replace(/\.?0+$/, "");
}

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Shared hover state: which index the pointer is nearest. */
function useHoverIndex(points: Point[], geom: Geometry) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [index, setIndex] = useState<number | null>(null);

  const onMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const svg = ref.current;
      if (!svg || !points.length) return;
      const rect = svg.getBoundingClientRect();
      // The SVG scales to its container, so map client px back to viewBox units.
      const vbX = ((e.clientX - rect.left) / rect.width) * geom.width;
      const plotW = geom.width - geom.padLeft - geom.padRight;
      const t = (vbX - geom.padLeft) / (plotW || 1);
      const i = Math.round(t * (points.length - 1));
      setIndex(Math.max(0, Math.min(points.length - 1, i)));
    },
    [points.length, geom],
  );

  return { ref, index, onMove, onLeave: () => setIndex(null) };
}

type ChartProps = {
  points: Point[];
  color: string;
  unitLabel?: string;
  geom?: Partial<Geometry>;
};

/** Line chart with crosshair and tooltip. Use for continuous measures. */
export function LineChart({ points, color, unitLabel, geom: geomOverride }: ChartProps) {
  const geom = { ...DEFAULT_GEOM, ...geomOverride };
  const { x, y, min, max, ticks, plotH } = useMemo(
    () => scales(points, geom, false),
    [points, geom],
  );
  const hover = useHoverIndex(points, geom);

  if (!points.length) return <EmptyPlot geom={geom} />;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");
  const area =
    `${path} L${x(points.length - 1)},${geom.padTop + plotH} L${x(0)},${geom.padTop + plotH} Z`;

  const active = hover.index === null ? null : points[hover.index];

  return (
    <figure className="chart">
      <svg
        ref={hover.ref}
        viewBox={`0 0 ${geom.width} ${geom.height}`}
        className="chart-svg"
        role="img"
        onPointerMove={hover.onMove}
        onPointerLeave={hover.onLeave}
      >
        <GridAndAxis geom={geom} min={min} max={max} ticks={ticks} points={points} />

        <path d={area} fill={color} opacity={0.1} />
        <path d={path} fill="none" stroke={color} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" />

        {hover.index !== null && active && (
          <>
            <line
              x1={x(hover.index)} x2={x(hover.index)}
              y1={geom.padTop} y2={geom.padTop + plotH}
              stroke="var(--baseline)" strokeWidth={1}
            />
            {/* 2px surface ring keeps the marker legible over the line. */}
            <circle cx={x(hover.index)} cy={y(active.value)} r={5}
                    fill={color} stroke="var(--surface-1)" strokeWidth={2} />
          </>
        )}
      </svg>
      {active && (
        <Tooltip day={active.day} value={active.value} n={active.n} unitLabel={unitLabel} />
      )}
    </figure>
  );
}

/** Bar chart with per-bar hover. Use for counted totals like steps. */
export function BarChart({ points, color, unitLabel, geom: geomOverride }: ChartProps) {
  const geom = { ...DEFAULT_GEOM, ...geomOverride };
  const { x, y, min, max, ticks, plotW, plotH } = useMemo(
    () => scales(points, geom, true),
    [points, geom],
  );
  const hover = useHoverIndex(points, geom);

  if (!points.length) return <EmptyPlot geom={geom} />;

  // 2px surface gap between adjacent bars, and never wider than a sane bar.
  const slot = plotW / points.length;
  const barW = Math.max(1, Math.min(slot - 2, 28));
  const baseline = geom.padTop + plotH;
  const active = hover.index === null ? null : points[hover.index];

  return (
    <figure className="chart">
      <svg
        ref={hover.ref}
        viewBox={`0 0 ${geom.width} ${geom.height}`}
        className="chart-svg"
        role="img"
        onPointerMove={hover.onMove}
        onPointerLeave={hover.onLeave}
      >
        <GridAndAxis geom={geom} min={min} max={max} ticks={ticks} points={points} />
        {points.map((p, i) => {
          const h = Math.max(0, baseline - y(p.value));
          return (
            <rect
              key={p.day}
              x={x(i) - barW / 2}
              y={baseline - h}
              width={barW}
              height={h}
              // 4px rounded data-end; the baseline end stays square.
              rx={Math.min(4, barW / 2)}
              fill={color}
              opacity={hover.index === null || hover.index === i ? 1 : 0.45}
            />
          );
        })}
      </svg>
      {active && (
        <Tooltip day={active.day} value={active.value} n={active.n} unitLabel={unitLabel} />
      )}
    </figure>
  );
}

function GridAndAxis({
  geom, min, max, ticks, points,
}: { geom: Geometry; min: number; max: number; ticks: number[]; points: Point[] }) {
  const plotH = geom.height - geom.padTop - geom.padBottom;

  // Show at most ~6 date labels so they never collide.
  const stride = Math.max(1, Math.ceil(points.length / 6));

  return (
    <g>
      {ticks.map((t) => {
        const ty = geom.padTop + plotH - ((t - min) / (max - min || 1)) * plotH;
        return (
          <g key={t}>
            <line
              x1={geom.padLeft} x2={geom.width - geom.padRight}
              y1={ty} y2={ty}
              stroke="var(--gridline)" strokeWidth={1}
            />
            <text x={geom.padLeft - 8} y={ty + 4} textAnchor="end" className="tick">
              {formatValue(t)}
            </text>
          </g>
        );
      })}
      {points.map((p, i) => {
        if (i % stride !== 0) return null;
        const plotW = geom.width - geom.padLeft - geom.padRight;
        const px = geom.padLeft + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
        // Anchor the edge labels inward so they cannot clip the viewBox.
        const nearEnd = px > geom.width - geom.padRight - 24;
        const nearStart = px < geom.padLeft + 24;
        return (
          <text
            key={p.day}
            x={px}
            y={geom.height - 8}
            textAnchor={nearEnd ? "end" : nearStart ? "start" : "middle"}
            className="tick"
          >
            {formatDay(p.day)}
          </text>
        );
      })}
    </g>
  );
}

function EmptyPlot({ geom }: { geom: Geometry }) {
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${geom.width} ${geom.height}`} className="chart-svg" role="img">
        <text x={geom.width / 2} y={geom.height / 2} textAnchor="middle" className="empty-text">
          No data in this range
        </text>
      </svg>
    </figure>
  );
}

function Tooltip({
  day, value, n, unitLabel,
}: { day: string; value: number; n: number; unitLabel?: string }) {
  return (
    <figcaption className="tooltip" role="status">
      <span className="tooltip-day">{formatDay(day)}</span>
      <span className="tooltip-value">
        {formatValue(value)}
        {unitLabel ? <span className="tooltip-unit"> {unitLabel}</span> : null}
      </span>
      <span className="tooltip-n">{n} {n === 1 ? "point" : "points"}</span>
    </figcaption>
  );
}

/** Compact trend line for the small-multiples grid. No axes, no hover. */
export function Sparkline({ points, color }: { points: Point[]; color: string }) {
  const w = 160;
  const h = 40;
  if (points.length < 2) return <svg viewBox={`0 0 ${w} ${h}`} className="sparkline" />;

  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;

  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p.value - min) / span) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="sparkline" role="img" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Seeds the local mirror with synthetic data for UI work, so the dashboard can
 * be developed without burning API quota. Not part of the sync path.
 *
 * Run: node --experimental-sqlite --experimental-strip-types src/seed.ts
 */
import { DATA_TYPES } from "./datatypes.ts";
import { upsertPoints, recordSync, type DataPointRow } from "./db.ts";

const DAYS = 120;
const today = new Date();
today.setUTCHours(0, 0, 0, 0);

function baseline(id: string): { base: number; jitter: number; perDay: number } {
  switch (id) {
    case "steps": return { base: 8400, jitter: 3800, perDay: 12 };
    case "distance": return { base: 6200, jitter: 2600, perDay: 12 };
    case "floors": return { base: 11, jitter: 7, perDay: 6 };
    case "heart-rate": return { base: 71, jitter: 16, perDay: 48 };
    case "daily-resting-heart-rate": return { base: 56, jitter: 5, perDay: 1 };
    case "heart-rate-variability": return { base: 42, jitter: 14, perDay: 4 };
    case "daily-heart-rate-variability": return { base: 44, jitter: 9, perDay: 1 };
    case "sleep": return { base: 421, jitter: 74, perDay: 1 };
    case "active-zone-minutes": return { base: 34, jitter: 22, perDay: 4 };
    case "active-minutes": return { base: 47, jitter: 25, perDay: 4 };
    case "active-energy-burned": return { base: 540, jitter: 240, perDay: 8 };
    case "basal-energy-burned": return { base: 1580, jitter: 70, perDay: 4 };
    case "total-calories": return { base: 2180, jitter: 310, perDay: 6 };
    case "oxygen-saturation": return { base: 96.4, jitter: 1.8, perDay: 6 };
    case "daily-oxygen-saturation": return { base: 96.2, jitter: 1.2, perDay: 1 };
    case "vo2-max": case "daily-vo2-max": return { base: 46, jitter: 3, perDay: 1 };
    case "weight": return { base: 72.5, jitter: 1.1, perDay: 1 };
    case "body-fat": return { base: 18.6, jitter: 1.4, perDay: 1 };
    case "daily-respiratory-rate": return { base: 14.4, jitter: 1.5, perDay: 1 };
    case "respiratory-rate-sleep-summary": return { base: 14.2, jitter: 1.3, perDay: 1 };
    case "exercise": return { base: 38, jitter: 22, perDay: 1 };
    default: return { base: 20, jitter: 10, perDay: 2 };
  }
}

const rows: DataPointRow[] = [];
for (const type of DATA_TYPES) {
  const { base, jitter, perDay } = baseline(type.id);
  for (let d = DAYS; d >= 0; d--) {
    const day = new Date(today.getTime() - d * 86_400_000);
    const iso = day.toISOString().slice(0, 10);
    // A weekly rhythm plus noise, so the charts show real-looking structure.
    const weekly = Math.sin((d / 7) * Math.PI * 2) * 0.35;
    const drift = (DAYS - d) / DAYS * 0.12;

    for (let k = 0; k < perDay; k++) {
      const noise = (Math.random() - 0.5) * 2;
      const value = Math.max(0, base * (1 + weekly * 0.25 + drift) + jitter * noise * 0.5);
      const start = new Date(day.getTime() + (k / perDay) * 86_400_000);
      rows.push({
        dataType: type.id,
        pointId: `${type.id}:${iso}:${k}`,
        startTime: start.toISOString(),
        endTime: start.toISOString(),
        day: iso,
        value: Number(value.toFixed(2)),
        unit: null,
        payload: JSON.stringify({ synthetic: true, day: iso, value }),
      });
    }
  }
  recordSync({
    dataType: type.id,
    from: new Date(today.getTime() - DAYS * 86_400_000),
    through: today,
  });
}

upsertPoints(rows);
console.log(`Seeded ${rows.length} synthetic points across ${DATA_TYPES.length} types.`);

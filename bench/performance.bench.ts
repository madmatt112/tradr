import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, it } from 'vitest';

import type { Granularity, PerformanceQueryInput } from '@tradr/shared';
import { generateBucketSeries } from '@tradr/shared/lib/performance';

import { runMigrations, runPostMigrations } from '@/db/migrate';
import * as schema from '@/db/schema';
import { accounts as accountsTable, users as usersTable } from '@/db/schema';
import { seedPositions } from '@/db/seed/positions.seed';
import { getPerformance } from '@/features/performance/performance.service';

// Preset definitions — inlined here (the canonical implementation lives in
// `apps/web/src/features/performance/utils/derivePresetRange.ts` but the
// bench config aliases `@` → `apps/api/src`, so we don't reach across into
// the web app. Six preset ids match the production timeframe selector.
type PerformancePreset = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'ytd' | 'all-time';
interface PresetRange {
  granularity: Granularity;
  start: string;
  end: string;
}
interface CurrencyHistoryRange {
  earliestClosedAt: string;
  mostRecentClosedAt: string;
  totalClosedPositions: number;
}

// UTC-only preset ranges anchored on a fixed `now`. The bench runs against
// TZ='UTC' so we can use Date.UTC directly without going through date-fns-tz.
function derivePresetRange(
  preset: PerformancePreset,
  history: CurrencyHistoryRange,
  now: Date,
): PresetRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const dow = now.getUTCDay();
  switch (preset) {
    case 'daily': {
      const end = new Date(Date.UTC(y, m, d + 1));
      const start = new Date(Date.UTC(y, m, d + 1 - 30));
      return { granularity: 'day', start: start.toISOString(), end: end.toISOString() };
    }
    case 'weekly': {
      // Sunday-start (weekStartDay=0). Snap to next Sunday strictly after `now`.
      const delta = (0 - dow + 7) % 7 || 7;
      const end = new Date(Date.UTC(y, m, d + delta));
      const start = new Date(Date.UTC(y, m, d + delta - 12 * 7));
      return { granularity: 'week', start: start.toISOString(), end: end.toISOString() };
    }
    case 'monthly': {
      const end = new Date(Date.UTC(y, m + 1, 1));
      const start = new Date(Date.UTC(y, m + 1 - 12, 1));
      return { granularity: 'month', start: start.toISOString(), end: end.toISOString() };
    }
    case 'yearly': {
      const earliestYear = new Date(history.earliestClosedAt).getUTCFullYear();
      const start = new Date(Date.UTC(earliestYear, 0, 1));
      const end = new Date(Date.UTC(y + 1, 0, 1));
      return { granularity: 'year', start: start.toISOString(), end: end.toISOString() };
    }
    case 'ytd': {
      const start = new Date(Date.UTC(y, 0, 1));
      const end = new Date(Date.UTC(y + 1, 0, 1));
      return { granularity: 'month', start: start.toISOString(), end: end.toISOString() };
    }
    case 'all-time': {
      const earliest = new Date(history.earliestClosedAt);
      const start = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), 1));
      const end = new Date(Date.UTC(y, m + 1, 1));
      return { granularity: 'month', start: start.toISOString(), end: end.toISOString() };
    }
  }
}

// ---------------------------------------------------------------------------
// Bench tunables
// ---------------------------------------------------------------------------
const DATASET_SIZE = 10_000;
const CONCURRENCY_DATASET_SIZE = 5_000;
const CONCURRENCY_PARALLELISM = 10;
const N_ITERATIONS = 50;
const N_WARMUP = 5;
const RNG_SEED = 0xc0ffee;
const BUCKET_SUBBENCH_TZ = 'Pacific/Apia';
const BUCKET_SUBBENCH_BUCKETS = 1_095;
const TZ = 'UTC';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASELINE_PATH = path.resolve(__dirname, 'baselines/performance.json');

const PRESETS: readonly PerformancePreset[] = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'ytd',
  'all-time',
];

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx]!;
}

function summarize(samples: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length > 0 ? sum / sorted.length : 0,
  };
}

// Wall-clock perf measurement; returned units are milliseconds.
function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1_000_000;
}

// ---------------------------------------------------------------------------
// Bench DB lifecycle (own pool — does NOT use the apps/api/src/db singleton).
// ---------------------------------------------------------------------------
let benchSql: ReturnType<typeof postgres>;
let benchDb: ReturnType<typeof drizzle<typeof schema>>;
let benchUserId: string;
let benchUserIdSmall: string;

// Fixed `nowInstant` so preset ranges are deterministic. Picks a recent date
// inside the seeded window so daily/weekly/monthly/ytd presets cover real data.
const NOW_INSTANT = new Date('2026-04-15T12:00:00.000Z');

const HISTORY_END = new Date('2026-04-01T00:00:00.000Z');
const HISTORY_START = new Date('2019-04-01T00:00:00.000Z'); // ~7 years back
const HISTORY_RANGE: CurrencyHistoryRange = {
  earliestClosedAt: HISTORY_START.toISOString(),
  mostRecentClosedAt: HISTORY_END.toISOString(),
  totalClosedPositions: DATASET_SIZE,
};

async function resetDatabase(sql: ReturnType<typeof postgres>): Promise<void> {
  // Drop all schema objects so a stale schema from a previous bench (or any
  // prior in-flight migration journal) doesn't clash with the migrations we
  // are about to re-apply. We drop `drizzle` (drizzle's migration ledger
  // schema) AND `public` (app tables). Safe — bench DB is dedicated and
  // isolated from app data.
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql`GRANT ALL ON SCHEMA public TO postgres`;
  await sql`GRANT ALL ON SCHEMA public TO public`;
}

async function seedUserAccounts(
  userEmailSuffix: string,
): Promise<{ userId: string; accounts: { USD: string; EUR: string; JPY: string } }> {
  const [user] = await benchDb
    .insert(usersTable)
    .values({
      email: `bench-${userEmailSuffix}-${Date.now()}@bench.local`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  if (!user) throw new Error('failed to seed bench user');

  const inserted = await benchDb
    .insert(accountsTable)
    .values([
      { userId: user.id, name: 'USD-Account', currency: 'USD' },
      { userId: user.id, name: 'EUR-Account', currency: 'EUR' },
      { userId: user.id, name: 'JPY-Account', currency: 'JPY' },
    ])
    .returning();

  const byCurrency: Record<string, string> = {};
  for (const a of inserted) byCurrency[a.currency] = a.id;
  if (!byCurrency.USD || !byCurrency.EUR || !byCurrency.JPY) {
    throw new Error('failed to seed bench accounts');
  }

  return {
    userId: user.id,
    accounts: { USD: byCurrency.USD, EUR: byCurrency.EUR, JPY: byCurrency.JPY },
  };
}

async function seedDataset(
  userId: string,
  accounts: { USD: string; EUR: string; JPY: string },
  total: number,
): Promise<void> {
  // Split evenly across USD/EUR/JPY.
  const perCurrency = Math.floor(total / 3);
  const remainder = total - perCurrency * 3;

  const closedAtRange = { start: HISTORY_START, end: HISTORY_END };

  await seedPositions(benchDb, {
    userId,
    accountId: accounts.USD,
    count: perCurrency + remainder,
    status: 'closed',
    closedAtRange,
    rngSeed: RNG_SEED,
  });
  await seedPositions(benchDb, {
    userId,
    accountId: accounts.EUR,
    count: perCurrency,
    status: 'closed',
    closedAtRange,
    rngSeed: RNG_SEED + 1,
  });
  await seedPositions(benchDb, {
    userId,
    accountId: accounts.JPY,
    count: perCurrency,
    status: 'closed',
    closedAtRange,
    rngSeed: RNG_SEED + 2,
  });
}

beforeAll(async () => {
  // Schema bootstrap: Task 0.5 only creates the empty DB; the `positions`
  // table doesn't exist until migrations run. Bench-owned reset + migrate +
  // post-migrate runs against the URL the bench config injected into env.
  // Read DATABASE_URL directly from env: the bench config injects it (so the
  // bench can target tradr_test_migrate without depending on apps/api's
  // config.ts boot path). No @/lib/config indirection here.
  // eslint-disable-next-line no-restricted-syntax
  benchSql = postgres(process.env.DATABASE_URL!, { max: 5 });
  benchDb = drizzle(benchSql, { schema });

  await resetDatabase(benchSql);
  await runMigrations();
  await runPostMigrations();

  // Main 10k user/dataset
  const main = await seedUserAccounts('main');
  benchUserId = main.userId;
  await seedDataset(main.userId, main.accounts, DATASET_SIZE);

  // Smaller 5k user/dataset for the concurrency sub-bench
  const small = await seedUserAccounts('small');
  benchUserIdSmall = small.userId;
  await seedDataset(small.userId, small.accounts, CONCURRENCY_DATASET_SIZE);
}, 600_000);

afterAll(async () => {
  await benchSql?.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('performance benchmark harness', () => {
  it('measures presets, concurrency, and bucket-series and writes a baseline JSON', async () => {
    const presetResults: Record<
      string,
      ReturnType<typeof summarize> & { granularity: string; bucketCount: number }
    > = {};

    // ---------- preset benches ----------
    for (const preset of PRESETS) {
      const range = derivePresetRange(preset, HISTORY_RANGE, NOW_INSTANT);
      const input: PerformanceQueryInput = {
        granularity: range.granularity,
        start: range.start,
        end: range.end,
        tz: TZ,
      };

      // warmup
      for (let i = 0; i < N_WARMUP; i++) {
        const ac = new AbortController();
        await getPerformance(benchDb, benchUserId, input, ac.signal, Date.now());
      }

      const samples: number[] = [];
      let bucketCount = 0;
      for (let i = 0; i < N_ITERATIONS; i++) {
        const ac = new AbortController();
        const t0 = nowMs();
        const res = await getPerformance(benchDb, benchUserId, input, ac.signal, Date.now());
        const elapsed = nowMs() - t0;
        samples.push(elapsed);
        if (i === 0) {
          bucketCount = res.currencies[0]?.series.length ?? 0;
        }
      }

      presetResults[preset] = {
        ...summarize(samples),
        granularity: range.granularity,
        bucketCount,
      };
    }

    // ---------- concurrency sub-bench (5k positions, 10 parallel) ----------
    const concurrencyRange = derivePresetRange('all-time', HISTORY_RANGE, NOW_INSTANT);
    const concurrencyInput: PerformanceQueryInput = {
      granularity: concurrencyRange.granularity,
      start: concurrencyRange.start,
      end: concurrencyRange.end,
      tz: TZ,
    };

    // warmup the concurrency path serially to prime caches
    for (let i = 0; i < N_WARMUP; i++) {
      const ac = new AbortController();
      await getPerformance(benchDb, benchUserIdSmall, concurrencyInput, ac.signal, Date.now());
    }

    const concurrencyWallSamples: number[] = [];
    const concurrencyPerRequestSamples: number[] = [];
    for (let i = 0; i < N_ITERATIONS; i++) {
      const wallStart = nowMs();
      const requests = Array.from({ length: CONCURRENCY_PARALLELISM }, async () => {
        const ac = new AbortController();
        const t0 = nowMs();
        await getPerformance(benchDb, benchUserIdSmall, concurrencyInput, ac.signal, Date.now());
        return nowMs() - t0;
      });
      const perReq = await Promise.all(requests);
      concurrencyWallSamples.push(nowMs() - wallStart);
      for (const t of perReq) concurrencyPerRequestSamples.push(t);
    }

    // ---------- generateBucketSeries sub-bench (1095 buckets, Pacific/Apia) ----------
    // Pick a 3-year span roughly anchored on a recent year. ~1095 buckets at
    // day granularity. Pacific/Apia has the worst-case DST behavior (incl.
    // the 2011 date-line skip; modern years still see DST transitions).
    const bucketStart = new Date('2023-01-01T00:00:00.000Z');
    const bucketEnd = new Date(
      bucketStart.getTime() + BUCKET_SUBBENCH_BUCKETS * 24 * 60 * 60 * 1000,
    );

    // warmup
    for (let i = 0; i < N_WARMUP; i++) {
      generateBucketSeries(bucketStart, bucketEnd, 'day', BUCKET_SUBBENCH_TZ, 0);
    }

    const bucketSamples: number[] = [];
    let bucketSeriesLength = 0;
    for (let i = 0; i < N_ITERATIONS; i++) {
      const t0 = nowMs();
      const series = generateBucketSeries(bucketStart, bucketEnd, 'day', BUCKET_SUBBENCH_TZ, 0);
      bucketSamples.push(nowMs() - t0);
      if (i === 0) bucketSeriesLength = series.length;
    }

    // ---------- assemble baseline JSON ----------
    const baseline = {
      generatedAt: new Date().toISOString(),
      datasetSize: DATASET_SIZE,
      concurrencyDatasetSize: CONCURRENCY_DATASET_SIZE,
      concurrencyParallelism: CONCURRENCY_PARALLELISM,
      iterations: N_ITERATIONS,
      warmup: N_WARMUP,
      rngSeed: RNG_SEED,
      nowInstant: NOW_INSTANT.toISOString(),
      timezone: TZ,
      node: process.version,
      platform: process.platform,
      presets: presetResults,
      concurrency: {
        wallClock: summarize(concurrencyWallSamples),
        perRequest: summarize(concurrencyPerRequestSamples),
      },
      bucketSeries: {
        tz: BUCKET_SUBBENCH_TZ,
        requestedBuckets: BUCKET_SUBBENCH_BUCKETS,
        actualBuckets: bucketSeriesLength,
        ...summarize(bucketSamples),
      },
    };

    await mkdir(path.dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');

    // Echo a compact summary so a CI/manual run shows progress without
    // requiring the reader to open the JSON.

    console.log(
      `[bench] wrote ${BASELINE_PATH}  presets=${PRESETS.length}  ` +
        `dataset=${DATASET_SIZE}  iters=${N_ITERATIONS}`,
    );
  }, 600_000);
});

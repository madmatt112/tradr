import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Calendar-and-breakdowns e2e suite — the design's End-to-End Testing section
 * run against the booted stack with the demo account.
 *
 * One journey, one freshly-registered demo user, walking the eight verification
 * steps of the spec:
 *
 *   1. Monthly preset; the March 2026 `breakdown-table` row, the calendar's
 *      March month total and its day cells all agree on net P&L.
 *   2. A full same-tab document load of the stale `tz=UTC` URL after the
 *      reporting zone changed to Asia/Tokyo re-buckets the NVDA close from the
 *      4 March cell to the 5 March cell (04:30 JST), and back when restored.
 *   3. `by=symbol` over all-time: the rows' net P&L sums to the total row and
 *      that row counts ten closed positions.
 *   4. `by=tag`: the `breakout` and `calm` rows (both holding AAPL) and an
 *      `Untagged` row (holding MSFT among others); every row shows win rate and
 *      profit factor; no reconciliation across the overlapping tag rows.
 *   5. `by=weekday` and `by=hour`: seven and twenty-four rows, counts summing to
 *      ten, with the populated buckets DERIVED in the test from each demo trade's
 *      exit instant under DD1 (the flat instant) — never presumed.
 *   6. A runtime breakeven position (enter 100 @ 10.00 / exit 100 @ 10.02, a
 *      1.00 fee each side) earns the Breakeven badge on its list row and detail,
 *      raises the breakeven rate, and is the only row under
 *      `?classification=breakeven` across a reload.
 *   7. `stat-Expectancy` is +1,728.00 ÷ 10 before step 6 and ÷ 11 after.
 *
 * Step 8 (the `pnpm --filter @tradr/web build` + `check-bundle-size.mjs` gate)
 * is a build check run outside Playwright, not a case here.
 *
 * ASSERTIONS ARE ON THE DOM, THE URL AND THE NETWORK, NEVER ON REACT STATE.
 * `ensureStackOrSkip` skips (not fails) when the API is down, matching every
 * other live suite here. This spec is NOT env-gated.
 */

// ---------------------------------------------------------------------------
// Test data + helpers (the tags-and-setups.spec.ts shape)
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-calbd-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login. `/register` is rate-limited per
 * client IP (5 / 15 min) and the harness trusts the loopback proxy
 * (`TRUSTED_PROXIES=127.0.0.1`), so a forwarded IP is what the limiter keys off.
 * The third octet — 126 — is this spec's own; every other suite's range is
 * taken. `process.pid` namespaces the worker.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.126.${ipCounter % 254}`;
}

/**
 * Register a user; the session cookie lands on `req`, so the returned context
 * stays authenticated as this user for the API-side setup and assertions.
 */
async function registerUser(req: APIRequestContext, label: string): Promise<string> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
}

/** Log in through the form. A unique forwarded IP keeps logins out of one bucket. */
async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Skip gracefully when the API is not up, rather than failing the run. */
async function ensureStackOrSkip(req: APIRequestContext): Promise<void> {
  try {
    const res = await req.get('/api/auth/me', { failOnStatusCode: false });
    if (res.status() >= 500) {
      test.skip(true, `API stack returned ${res.status()} — skipping live e2e`);
    }
  } catch (err) {
    test.skip(true, `API stack unreachable — skipping live e2e (${(err as Error).message})`);
  }
}

/** Set the stored reporting timezone directly, so the first URL is deterministically `tz=UTC`. */
async function setReportingTimezone(req: APIRequestContext, timezone: string): Promise<void> {
  const res = await req.put('/api/users/me/timezone', { data: { timezone } });
  expect(res.status(), `PUT reporting timezone ${timezone}`).toBe(200);
}

/** The demo account's id, matched on its stable seed name. */
async function demoAccountId(req: APIRequestContext): Promise<string> {
  const res = await req.get('/api/accounts');
  expect(res.status(), 'GET /accounts').toBe(200);
  const accounts = (await res.json()) as { id: string; name: string }[];
  const demo = accounts.find((a) => a.name === 'Demo Account');
  expect(demo, 'demo account present').toBeTruthy();
  return demo!.id;
}

/**
 * Drive one closed position through the real lifecycle over the API — the same
 * path the demo seed uses — so its realized P&L is derived by the accounting
 * hooks rather than inserted. Returns the position id.
 */
async function createClosedPosition(
  req: APIRequestContext,
  accountId: string,
  opts: {
    symbol: string;
    quantity: string;
    entryPrice: string;
    exitPrice: string;
    fee: string;
    entryAt: string;
    exitAt: string;
  },
): Promise<string> {
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol: opts.symbol, side: 'long', assetType: 'stock' },
  });
  expect(posRes.status(), 'POST /positions').toBe(201);
  const id = ((await posRes.json()) as { id: string }).id;

  const entry = await req.post(`/api/positions/${id}/fills`, {
    data: {
      type: 'entry',
      price: opts.entryPrice,
      quantity: opts.quantity,
      fees: opts.fee,
      filledAt: opts.entryAt,
    },
  });
  expect(entry.status(), 'POST entry fill').toBe(201);
  const open = await req.post(`/api/positions/${id}/open`, { data: { openedAt: opts.entryAt } });
  expect(open.status(), 'POST /open').toBe(200);
  // A reconciling exit fill auto-closes the position at its own `filledAt`
  // (positions.service.ts addFill R7 amendment), so no separate close call — a
  // manual /close here would 409 against the already-closed position.
  const exit = await req.post(`/api/positions/${id}/fills`, {
    data: {
      type: 'exit',
      price: opts.exitPrice,
      quantity: opts.quantity,
      fees: opts.fee,
      filledAt: opts.exitAt,
    },
  });
  expect(exit.status(), 'POST exit fill').toBe(201);
  const detail = await req.get(`/api/positions/${id}`);
  expect(detail.status(), 'GET position after exit').toBe(200);
  expect(((await detail.json()) as { status: string }).status, 'auto-closed on full exit').toBe(
    'closed',
  );
  return id;
}

// ---------------------------------------------------------------------------
// Money / figure parsing — DOM figures reduced to integer minor units so the
// comparisons are exact (the `Numeric` sign lives in U+2212 for a loss, U+002B
// for a gain; the money body carries the currency symbol and grouping).
// ---------------------------------------------------------------------------

/** A rendered `Numeric` money string ("−$352.00", "+$323.00") to integer cents. */
function moneyToCents(text: string | null): number {
  const norm = (text ?? '')
    .replace(/[$,\s ]/g, '')
    .replace('−', '-')
    .replace('+', '');
  return Math.round(Number.parseFloat(norm) * 100);
}

/** A signed decimal figure from a calendar aria-label ("+323.00", "−352.00") to cents. */
function signedToCents(text: string): number {
  const norm = text.replace(/,/g, '').replace('−', '-').replace('+', '');
  return Math.round(Number.parseFloat(norm) * 100);
}

/** A rendered percent string ("70.0%", "9.1%") to a number. */
function percentToNumber(text: string | null): number {
  return Number.parseFloat((text ?? '').replace(/%/g, '').replace('−', '-'));
}

// ---------------------------------------------------------------------------
// The demo seed's ten closed exit instants, mirrored from
// accounts.demo.ts:113 (DEMO_TRADES). The weekday/hour verification (step 5)
// DERIVES its expected buckets from these under DD1 — the flat instant is the
// close instant for a single-exit trade — rather than presuming an hour range.
// ---------------------------------------------------------------------------
const DEMO_CLOSED_EXITS = [
  '2026-02-19T18:20:00.000Z', // AAPL
  '2026-03-02T17:05:00.000Z', // MSFT
  '2026-03-04T19:30:00.000Z', // NVDA
  '2026-03-18T15:45:00.000Z', // TSLA
  '2026-03-31T18:55:00.000Z', // AMD
  '2026-04-24T19:10:00.000Z', // SPY
  '2026-05-01T17:40:00.000Z', // META
  '2026-05-19T18:15:00.000Z', // GOOGL
  '2026-06-17T18:30:00.000Z', // AMZN
  '2026-07-08T19:00:00.000Z', // QQQ
] as const;

// DD12 weekday labels (breakdown.ts), indexed by getUTCDay() (0 = Sunday).
const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * The expected populated buckets, computed from the exit instants in the
 * reporting zone (UTC for these steps — `getUTC*` matches `toZonedTime(x, 'UTC')`
 * which drives `attributionParts`). Returns label → count.
 */
function deriveWeekdayCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const iso of DEMO_CLOSED_EXITS) {
    const label = WEEKDAY_LABELS[new Date(iso).getUTCDay()];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}
function deriveHourCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const iso of DEMO_CLOSED_EXITS) {
    const hour = new Date(iso).getUTCHours();
    const label = `${hour < 10 ? `0${hour}` : String(hour)}:00`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// DOM readers scoped to the performance page (the side drawer mounts its own
// performance surface, so figures are read from inside `performance-page`).
// ---------------------------------------------------------------------------

const PAGE = '[data-testid="performance-page"]';
const DIM_TABLE = `${PAGE} [data-testid="dimension-breakdown-table"]`;

/** Text of the single `Numeric` inside the nth cell of a row locator. */
async function cellNumeric(row: ReturnType<Page['locator']>, index: number): Promise<string> {
  return (
    (await row.locator('td').nth(index).locator('[data-testid="numeric"]').textContent()) ?? ''
  );
}

test.describe('calendar and breakdowns', () => {
  // Desktop only, and the reporting-zone flip needs a deterministic browser
  // zone: pin the context to UTC (so the picker offers UTC and the seed URL is
  // `tz=UTC`) and en-US (so Intl figures/labels are stable).
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile);
  test.use({ timezoneId: 'UTC', locale: 'en-US' });

  test.beforeEach(async ({ request }) => {
    await ensureStackOrSkip(request);
  });

  test('demo account: calendar, breakdowns, breakeven and expectancy', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    // ---- Setup: demo user with a UTC reporting zone, then the demo account ---
    const email = await registerUser(request, 'demo');
    await setReportingTimezone(request, 'UTC');
    await loginViaUi(page, email);
    await expect(page.getByTestId('activation-checklist')).toBeVisible();
    await page.getByTestId('zero-state-sample-data').click();
    // The seed drives fourteen trades through the real lifecycle in one
    // transaction, so it is the slowest write in the product.
    await expect(page.getByTestId('demo-banner')).toBeVisible({ timeout: 30_000 });

    let staleUtcUrl = '';

    // ---- Step 1: monthly preset, March 2026 calendar reconciles ------------
    await test.step('1. March calendar day cells and month total match the breakdown row', async () => {
      // A complete monthly window whose `end` sits in the past (every demo close
      // is ≤ 2026-07-08). The bare-URL monthly default ends at start-of-tomorrow,
      // and step 2 resyncs the reporting zone to Asia/Tokyo — a zone ahead of UTC
      // — under which that near-now `end` exceeds the schema's "today + 1 day"
      // bound and 400s the page. A past `end` keeps this a monthly view over
      // March 2026 and every closed demo trade without that edge (see the RETRO
      // reported for the loop: the resync + near-now window crash is a real one).
      await page.goto(
        '/performance?granularity=month&start=2025-10-01T00:00:00.000Z&end=2026-08-01T00:00:00.000Z&tz=UTC',
      );
      await expect(page.locator(PAGE)).toBeVisible();
      await expect(page.locator(`${PAGE} [data-testid="breakdown-table"]`)).toBeVisible();
      await expect(page.locator(`${PAGE} [data-testid="pnl-calendar"]`)).toBeVisible();

      // Navigate the calendar back to March 2026 through the month control.
      const title = page.getByTestId('calendar-month-title');
      const prev = page.getByTestId('calendar-prev');
      await expect
        .poll(
          async () => {
            const t = (await title.textContent())?.trim();
            if (t !== 'March 2026') await prev.click();
            return t;
          },
          { timeout: 30_000, intervals: [200] },
        )
        .toBe('March 2026');
      await expect(page).toHaveURL(/month=2026-03/);

      // The month header total equals the "Mar 2026" breakdown-table row net.
      const marchRow = page
        .locator(`${PAGE} [data-testid="breakdown-table"] tbody tr`)
        .filter({ hasText: 'Mar 2026' });
      await expect(marchRow).toHaveCount(1);
      const marchRowNet = (await cellNumeric(marchRow, 5)).trim();
      const monthTotalText = (
        (await page
          .locator('[data-testid="calendar-month-total"] [data-testid="numeric"]')
          .first()
          .textContent()) ?? ''
      ).trim();
      expect(monthTotalText).toBe(marchRowNet);

      // The active day cells sum (as exact minor units) to that same figure.
      const dayCells = page.locator(`${PAGE} [data-testid="pnl-calendar"] tbody td[aria-label]`);
      const count = await dayCells.count();
      let sumCents = 0;
      let activeDays = 0;
      for (let i = 0; i < count; i++) {
        const label = (await dayCells.nth(i).getAttribute('aria-label')) ?? '';
        if (label.includes('no activity')) continue;
        const m = label.match(/:\s*([+\-−][\d,]+\.\d{2})\s+USD/);
        expect(m, `figure in "${label}"`).not.toBeNull();
        sumCents += signedToCents(m![1]);
        activeDays += 1;
      }
      expect(activeDays).toBeGreaterThan(0);
      expect(sumCents).toBe(moneyToCents(marchRowNet));

      staleUtcUrl = page.url();
      expect(staleUtcUrl).toMatch(/tz=UTC/);
    });

    // ---- Step 2: the reload-durable reporting-zone flip --------------------
    await test.step('2. NVDA close moves 4 → 5 March on the stale-URL reload and back', async () => {
      const cell4 = page.locator(
        `${PAGE} [data-testid="pnl-calendar"] td[aria-label^="March 4, 2026:"]`,
      );
      const cell5 = page.locator(
        `${PAGE} [data-testid="pnl-calendar"] td[aria-label^="March 5, 2026:"]`,
      );

      // Before: in UTC the NVDA close is on 4 March; 5 March is empty.
      await expect(cell4).toHaveAttribute('aria-label', /USD, \d+ positions?$/);
      await expect(cell5).toHaveAttribute('aria-label', /no activity$/);

      // Change the reporting zone to Asia/Tokyo on Settings → Profile.
      await page.goto('/settings/profile');
      await page.locator('#reportingTimezone').click();
      await page.getByRole('option', { name: 'Asia/Tokyo' }).click();
      await expect(page.locator('#reportingTimezone')).toContainText('Asia/Tokyo');

      // A full same-tab document load of the exact stale tz=UTC URL — not a
      // goBack, not a bare /performance (R7-1). The reload-durable provenance
      // store recorded in step 1 survives the load and resyncs tz to Tokyo.
      await page.goto(staleUtcUrl);
      await expect(page.locator(`${PAGE} [data-testid="pnl-calendar"]`)).toBeVisible();
      await expect(page).toHaveURL(/tz=Asia%2FTokyo/);

      // After: 04:30 JST on 5 March; 4 March is now empty.
      await expect(cell5).toHaveAttribute('aria-label', /USD, \d+ positions?$/);
      await expect(cell4).toHaveAttribute('aria-label', /no activity$/);
      const tokyoUrl = page.url();

      // Set the zone back to UTC (the picker no longer offers UTC once Tokyo is
      // stored, so restore it over the API) and reload the Tokyo URL: the
      // provenance resync rewrites tz back to UTC and the close returns to 4 March.
      await setReportingTimezone(request, 'UTC');
      await page.goto(tokyoUrl);
      await expect(page.locator(`${PAGE} [data-testid="pnl-calendar"]`)).toBeVisible();
      await expect(page).toHaveURL(/tz=UTC/);
      await expect(cell4).toHaveAttribute('aria-label', /USD, \d+ positions?$/);
      await expect(cell5).toHaveAttribute('aria-label', /no activity$/);
    });

    let expectancyBefore = '';
    let winRateBefore = '';
    let breakevenRateBefore = '';

    // ---- Step 3: by=symbol over all-time reconciles to ten -----------------
    await test.step('3. by=symbol all-time: rows sum to the total row, count is ten', async () => {
      await page.goto('/performance');
      await expect(page.locator(PAGE)).toBeVisible();
      await page.getByTestId('timeframe-preset-all-time').click();
      await expect(page).toHaveURL(/granularity=month/);
      // Symbol is the default dimension.
      await expect(page.getByTestId('breakdown-dimension-symbol')).toHaveAttribute(
        'aria-selected',
        'true',
      );

      const total = page.locator('[data-testid="dimension-breakdown-total"]');
      await expect(total.locator('td').nth(1).locator('[data-testid="numeric"]')).toHaveText('10');

      const rows = page.locator(`${DIM_TABLE} tbody tr`);
      await expect(rows).toHaveCount(10);
      let sumCents = 0;
      for (let i = 0; i < 10; i++) {
        sumCents += moneyToCents(await cellNumeric(rows.nth(i), 3));
      }
      expect(sumCents).toBe(moneyToCents(await cellNumeric(total, 3)));

      // Capture the pre-breakeven Expectancy (+1,728.00 ÷ 10) and the rates.
      expectancyBefore = (
        (await page.locator(`${PAGE} [data-testid="stat-Expectancy"]`).textContent()) ?? ''
      ).trim();
      expect(expectancyBefore).toBe('+$172.80');
      winRateBefore = (
        (await page.locator(`${PAGE} [data-testid="stat-Win Rate"]`).textContent()) ?? ''
      ).trim();
      breakevenRateBefore = (
        (await page.locator(`${PAGE} [data-testid="stat-Breakeven Rate"]`).textContent()) ?? ''
      ).trim();
    });

    // ---- Step 4: by=tag, overlapping rows, no reconciliation ---------------
    await test.step('4. by=tag: breakout/calm/Untagged rows, every row rated', async () => {
      await page.getByTestId('breakdown-dimension-tag').click();
      await expect(page).toHaveURL(/by=tag/);

      // The multi-valued dimension shows the explanatory note and NO total row.
      await expect(page.locator(`${PAGE} [data-testid="dimension-breakdown-note"]`)).toBeVisible();
      await expect(page.locator('[data-testid="dimension-breakdown-total"]')).toHaveCount(0);

      // AAPL is the only closed breakout position and shares the calm row with
      // QQQ, so a breakout row of one and a calm row of two put AAPL in both.
      const breakout = page
        .locator(`${DIM_TABLE} tbody tr`)
        .filter({ has: page.locator('[aria-label="setup: breakout"]') });
      const calm = page
        .locator(`${DIM_TABLE} tbody tr`)
        .filter({ has: page.locator('[aria-label="emotion: calm"]') });
      const untagged = page.locator(`${DIM_TABLE} tbody tr`).filter({ hasText: 'Untagged' });
      await expect(breakout).toHaveCount(1);
      await expect(calm).toHaveCount(1);
      await expect(untagged).toHaveCount(1);
      expect(Number.parseInt(await cellNumeric(breakout, 1), 10)).toBe(1);
      expect(Number.parseInt(await cellNumeric(calm, 1), 10)).toBe(2);
      // The four untagged closed positions include MSFT.
      expect(Number.parseInt(await cellNumeric(untagged, 1), 10)).toBeGreaterThanOrEqual(1);

      // Every row shows a win rate and a profit factor (a figure, ∞ or em-dash
      // where a row has no losses) — no cell is blank.
      const rows = page.locator(`${DIM_TABLE} tbody tr`);
      const n = await rows.count();
      expect(n).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < n; i++) {
        const winRate = (await rows.nth(i).locator('td').nth(2).textContent())?.trim() ?? '';
        const profitFactor = (await rows.nth(i).locator('td').nth(4).textContent())?.trim() ?? '';
        expect(winRate.length, `win rate row ${i}`).toBeGreaterThan(0);
        expect(profitFactor.length, `profit factor row ${i}`).toBeGreaterThan(0);
      }
    });

    // ---- Step 5: by=weekday and by=hour, buckets derived from exit instants -
    await test.step('5. by=weekday and by=hour: derived buckets sum to ten', async () => {
      // by=weekday — seven rows, populated buckets derived from the exit instants.
      await page.getByTestId('breakdown-dimension-weekday').click();
      await expect(page).toHaveURL(/by=weekday/);
      await expect(page.locator('[data-testid="dimension-breakdown-total"]')).toHaveCount(1);
      const weekdayRows = page.locator(`${DIM_TABLE} tbody tr`);
      await expect(weekdayRows).toHaveCount(7);
      await assertDerivedBuckets(weekdayRows, deriveWeekdayCounts());

      // by=hour — twenty-four rows, same derivation.
      await page.getByTestId('breakdown-dimension-hour').click();
      await expect(page).toHaveURL(/by=hour/);
      const hourRows = page.locator(`${DIM_TABLE} tbody tr`);
      await expect(hourRows).toHaveCount(24);
      await assertDerivedBuckets(hourRows, deriveHourCounts());
    });

    async function assertDerivedBuckets(
      rows: ReturnType<Page['locator']>,
      expected: Map<string, number>,
    ): Promise<void> {
      const n = await rows.count();
      let sum = 0;
      const seen = new Map<string, number>();
      for (let i = 0; i < n; i++) {
        const label = (await rows.nth(i).locator('td').nth(0).textContent())?.trim() ?? '';
        const positions = Number.parseInt(await cellNumeric(rows.nth(i), 1), 10);
        seen.set(label, positions);
        sum += positions;
      }
      expect(sum).toBe(10);
      for (const [label, count] of expected) {
        expect(seen.get(label), `bucket ${label}`).toBe(count);
      }
    }

    // ---- Step 6: a runtime breakeven position ------------------------------
    let breakevenId = '';
    await test.step('6. breakeven position earns its badge and filter', async () => {
      const accountId = await demoAccountId(request);
      breakevenId = await createClosedPosition(request, accountId, {
        symbol: 'AAPL',
        quantity: '100',
        entryPrice: '10.00',
        exitPrice: '10.02',
        fee: '1.00',
        entryAt: '2026-08-01T14:00:00.000Z',
        exitAt: '2026-08-15T14:00:00.000Z',
      });

      // The list filter returns only it, and reloads to the same view.
      await page.goto('/positions?classification=breakeven');
      const rows = page.locator('table tbody tr');
      await expect(rows).toHaveCount(1);
      await expect(
        rows.getByLabel('Net profit and loss rounds to zero in the account currency'),
      ).toBeVisible();
      await page.reload();
      await expect(page).toHaveURL(/classification=breakeven/);
      await expect(page.locator('table tbody tr')).toHaveCount(1);

      // The detail shows the same badge.
      await page.goto(`/positions/${breakevenId}`);
      await expect(
        page.getByLabel('Net profit and loss rounds to zero in the account currency'),
      ).toBeVisible();
    });

    // ---- Step 7: Expectancy denominator ------------------------------------
    await test.step('7. Expectancy is +1,728.00 ÷ 11 after the breakeven, breakeven rate up', async () => {
      await page.goto('/performance');
      await expect(page.locator(PAGE)).toBeVisible();
      await page.getByTestId('timeframe-preset-all-time').click();
      await expect(page).toHaveURL(/granularity=month/);
      await expect(page.locator(`${PAGE} [data-testid="stats-panel"]`)).toBeVisible();

      const expectancyAfter = (
        (await page.locator(`${PAGE} [data-testid="stat-Expectancy"]`).textContent()) ?? ''
      ).trim();
      expect(expectancyAfter).toBe('+$157.09');

      const winRateAfter = (
        (await page.locator(`${PAGE} [data-testid="stat-Win Rate"]`).textContent()) ?? ''
      ).trim();
      const breakevenRateAfter = (
        (await page.locator(`${PAGE} [data-testid="stat-Breakeven Rate"]`).textContent()) ?? ''
      ).trim();
      // Win rate excludes breakevens from its denominator, so it is unchanged;
      // the breakeven rate rises.
      expect(winRateAfter).toBe(winRateBefore);
      expect(percentToNumber(breakevenRateAfter)).toBeGreaterThan(
        percentToNumber(breakevenRateBefore),
      );
    });
  });
});

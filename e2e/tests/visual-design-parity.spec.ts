import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Visual-design parity smoke — visual-design Task 19 (final), REQ-9.2, 9.5,
 * 10.2, 12.2.
 *
 * A GATING chromium e2e (distinct from Task 1's env-guarded, non-gating
 * `visual-design-reference.spec.ts` pixel reference). It asserts TWO runtime
 * guarantees that the deterministic node gates cannot see:
 *
 *   1. TOKEN RESOLUTION (REQ-10.2): the REAL in-app sidebar "Toggle theme"
 *      button flips `.dark`, and a token-driven element's COMPUTED color
 *      resolves to the DARK value (not the light one) — proving the
 *      `@custom-variant dark` + `.dark` block wiring drives the live toggle, not
 *      just `prefers-color-scheme`.
 *
 *   2. MONEY-DIRECTION ENCODING (REQ-12.2): a GAIN and a LOSS render with the
 *      always-on SIGN (`+` / `−`) — the non-color direction channel — plus the
 *      gain/loss color across the structured-figure surfaces that own the
 *      money-direction primitive — the positions table, the side drawer (Quick
 *      Stats), and a chart (dashboard performance bars). This asserts the encoding
 *      is consistent, NOT pixel equality. The advisor surface is asserted via token
 *      resolution (1): its
 *      money figures are LLM-AUTHORED MARKDOWN PROSE, not a structured Numeric
 *      render, and a live assistant reply is not deterministically reachable in
 *      e2e (no out-of-process LLM stub — advisor-tools.spec.ts header), so the
 *      advisor is proven to participate in the `.dark` substrate rather than
 *      asserting a synthetic prose figure.
 *
 * Determinism: the session + the sidebar toggle are REAL (registered user, UI
 * login), so the toggle assertion exercises the shipped wiring. The figure DATA
 * is `page.route`-mocked so both a gain AND a loss are present on every surface
 * without depending on seeded P&L history — the chart + drawer Quick Stats both
 * read `/api/performance`; the table reads `/api/positions`.
 *
 * STACK REQUIREMENT: dev stack (web + api + db) must be running — Playwright
 * boots web/api/stub via playwright.config.ts. Skips gracefully if unreachable.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-parity-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register call — `/register` is rate-limited per
 * client IP and the harness trusts `127.0.0.1` as a proxy (playwright.config.ts)
 * so the limiter keys off this forwarded IP. A distinct 3rd octet (.131) keeps
 * this spec's limiter bucket separate from the other specs'.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.131.${ipCounter % 254}`;
}

interface SeededUser {
  email: string;
  userId: string;
}

async function registerUser(req: APIRequestContext, label: string): Promise<SeededUser> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  const body = (await res.json()) as { user: { id: string } };
  return { email, userId: body.user.id };
}

async function loginViaUi(page: Page, email: string): Promise<void> {
  // UI logins reach the API through the loopback Vite proxy, so without a unique
  // forwarded IP every spec's logins share ONE rate-limit bucket (login: 10 / 15
  // min) and the long single-worker run trips 429 → the app redirects to
  // /login?expired=true. Mirror the register pattern: a unique X-Forwarded-For
  // per login gives each its own bucket (TRUSTED_PROXIES=127.0.0.1).
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

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

/**
 * Drive the sidebar "Toggle theme" menu (dashboard.spec.ts:325-335 pattern) and
 * assert the `.dark` class on <html> matches before returning.
 */
async function setTheme(page: Page, theme: 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.getByRole('menuitemradio', { name: theme }).click();
  if (theme === 'Dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  }
}

/**
 * Approximate lightness (0..1) of a browser-computed CSS color. Modern Chromium
 * returns the color in its authored space (`oklch(...)` here) rather than always
 * down-converting to `rgb(...)`, so handle both: oklch's first component IS the
 * perceptual lightness; rgb falls back to sRGB relative luminance.
 */
function lightnessOf(color: string): number {
  const oklch = /oklch\(\s*([0-9.]+%?)/i.exec(color);
  if (oklch) {
    const raw = oklch[1];
    return raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(color);
  if (rgb) {
    const [r, g, b] = rgb[1]
      .split(/[ ,/]+/)
      .slice(0, 3)
      .map((c) => Number(c.trim()) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  throw new Error(`unparseable computed color: ${color}`);
}

/**
 * Resolve the `--color-background` token to a concrete browser-computed color.
 * A probe div with `background-color: var(--color-background)` forces the engine
 * to resolve the cascade variable (`getComputedStyle().backgroundColor` returns
 * a resolved `rgb(...)`/`color(...)`, never the raw `var()` text), so this reads
 * the value the `.dark` block actually drives — not the source-text token.
 */
async function resolvedBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--color-background)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
}

// ---------------------------------------------------------------------------
// Figure-data mocks. Both a gain AND a loss are present on every surface so the
// encoding assertion sees both directions deterministically.
// ---------------------------------------------------------------------------

const GAIN = '120.00';
const LOSS = '-80.00';

const PERF_RESPONSE = {
  resolvedTimezone: 'UTC',
  resolvedWeekStartDay: 0 as const,
  dataQuality: {
    timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
    historyExcluded: { total: 0, closed_at_null: 0 },
  },
  hasAnyAccounts: true,
  hasAnyClosedPositions: true,
  hasAnyClosedPositionsInSupportedCurrency: true,
  defaultCurrency: 'USD',
  currencies: [
    {
      code: 'USD',
      historyRange: {
        earliestClosedAt: '2025-01-01T00:00:00.000Z',
        mostRecentClosedAt: '2026-05-01T00:00:00.000Z',
        totalClosedPositions: 8,
      },
      // One gain bucket + one loss bucket → the bar chart draws a gain-coloured
      // bar with a `+` label AND a loss-coloured bar with a `−` label.
      series: [
        {
          bucketStart: '2026-03-01T00:00:00.000Z',
          netPnl: GAIN,
          grossPnl: '150.00',
          fees: '30.00',
          totalPositions: 4,
          wins: 3,
          losses: 1,
          breakevens: 0,
        },
        {
          bucketStart: '2026-04-01T00:00:00.000Z',
          netPnl: LOSS,
          grossPnl: '-60.00',
          fees: '20.00',
          totalPositions: 4,
          wins: 1,
          losses: 3,
          breakevens: 0,
        },
      ],
      equityCurve: [
        { bucketStart: '2026-03-01T00:00:00.000Z', cumulativeNetPnl: GAIN },
        { bucketStart: '2026-04-01T00:00:00.000Z', cumulativeNetPnl: '40.00' },
      ],
      // avgWin (gain) + avgLoss (loss) drive the drawer Quick Stats numerics.
      stats: {
        totalPositions: 8,
        totalNetPnl: '40.00',
        winRate: 50.0,
        breakevenRate: 0.0,
        avgWin: GAIN,
        avgLoss: LOSS,
        profitFactor: 1.5,
        largestWin: '120.00',
        largestLoss: '-80.00',
        hasWins: true,
        hasLosses: true,
      },
    },
  ],
};

/** Two closed positions — one gain, one loss — for the positions table. */
function positionsResponse(accountId: string, userId: string) {
  const base = {
    userId,
    accountId,
    assetType: 'stock' as const,
    status: 'closed' as const,
    notes: null,
    openedAt: '2026-03-01T14:30:00.000Z',
    closedAt: '2026-03-10T14:30:00.000Z',
    createdAt: '2026-03-01T14:30:00.000Z',
    updatedAt: '2026-03-10T14:30:00.000Z',
    accountName: 'USD Account',
    accountCurrency: 'USD',
    returnPercentage: null,
    avgEntryPrice: 100,
    avgExitPrice: 110,
    totalEntryQuantity: 10,
    totalExitQuantity: 10,
    brokerageName: null,
    brokerageFees: 0,
  };
  return [
    {
      ...base,
      id: '00000000-0000-4000-8000-0000000000a1',
      symbol: 'GAINR',
      side: 'long' as const,
      realizedPnl: 120,
      grossPnl: 120,
      netPnl: 120,
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-0000000000a2',
      symbol: 'LOSSR',
      side: 'long' as const,
      realizedPnl: -80,
      grossPnl: -80,
      netPnl: -80,
    },
  ];
}

/**
 * Layer the figure-data mocks over the (real) session. Registered AFTER login so
 * the auth flow hits the real API; these intercept only the data reads.
 */
async function mockFigureData(
  page: Page,
  ctx: { accountId: string; userId: string },
): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route(/\/api\/performance(\?.*)?$/, (route) => route.fulfill(json(PERF_RESPONSE)));
  await page.route(/\/api\/positions(\?.*)?$/, (route) =>
    route.fulfill(json(positionsResponse(ctx.accountId, ctx.userId))),
  );
  await page.route('**/api/users/me/display-currency', (route) =>
    route.fulfill(json({ currency: 'USD' })),
  );
}

// ---------------------------------------------------------------------------

const SIGN_GAIN = '+';
const SIGN_LOSS = '−'; // U+2212 MINUS SIGN (Numeric uses this, not '-')

test.describe('visual-design parity smoke', () => {
  // Chromium desktop only — the parity smoke is the desktop chrome (the sidebar
  // toggle + drawer + chart assertions assume the desktop layout).
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop chromium only.',
  );

  let user: SeededUser;
  let accountId: string;

  test.beforeAll(async ({ request }) => {
    await ensureStackOrSkip(request);
    user = await registerUser(request, 'main');
  });

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('the in-app toggle resolves dark token values on key surfaces', async ({ page }) => {
    await loginViaUi(page, user.email);
    await expect(page.locator('section[data-widget-id]').first()).toBeVisible();

    // Light: the background token resolves to a LIGHT (high-lightness) value.
    await setTheme(page, 'Light');
    const lightBg = await resolvedBackground(page);
    const lightL = lightnessOf(lightBg);
    expect(lightL, `light background should be light: ${lightBg}`).toBeGreaterThan(0.7);

    // Dark: the SAME token now resolves to a DARK (low-lightness) value — proving
    // the `.dark` block (not prefers-color-scheme) drove the in-app toggle.
    await setTheme(page, 'Dark');
    const darkBg = await resolvedBackground(page);
    const darkL = lightnessOf(darkBg);
    expect(darkL, `dark background should be dark: ${darkBg}`).toBeLessThan(0.3);
    expect(darkL, 'dark background must differ from light').toBeLessThan(lightL);
  });

  test('gain vs loss render with the leading sign across table / drawer / chart; advisor re-themes', async ({
    page,
  }) => {
    await loginViaUi(page, user.email);

    // Seed one real account so the mocked positions reference a real id (the
    // mocks own the figure shapes; the account just exists for completeness).
    const accountRes = await page.request.post('/api/accounts', {
      data: { name: 'USD Account', currency: 'USD' },
    });
    expect(accountRes.status(), 'POST /accounts').toBe(201);
    accountId = ((await accountRes.json()) as { id: string }).id;

    await mockFigureData(page, { accountId, userId: user.userId });
    // Run the encoding checks in DARK so both themes are exercised (toggle test
    // covers light; this covers the dark-theme figure rendering).
    await page.goto('/dashboard');
    await setTheme(page, 'Dark');

    // --- (a) Chart — dashboard performance bars carry signed labels ---
    await expect(page.getByTestId('performance-bar-chart')).toBeVisible();
    const chart = page.getByTestId('performance-bar-chart');
    // Signed data labels (SVG <text>): a `+`-signed gain label AND a negative
    // loss label, each filled with the gain/loss token (the B&W direction
    // channel — R6.3). The chart's signed labels come from `Intl.NumberFormat`
    // (`signDisplay: exceptZero`) whose minus is the ASCII hyphen `-`, distinct
    // from the Numeric primitive's typographic U+2212; the encoding INTENT
    // (a leading sign per direction) is what this asserts.
    await expect(
      chart.locator('text', { hasText: /\+[\d,]+/ }).first(),
      'chart should draw a gain-signed label',
    ).toBeVisible();
    await expect(
      chart.locator('text', { hasText: /[-−][\d,]+/ }).first(),
      'chart should draw a loss-signed label',
    ).toBeVisible();
    // The loss bar carries the loss token fill (direction also in colour).
    await expect(
      chart.locator('path[fill="var(--color-loss)"], rect[fill="var(--color-loss)"]').first(),
      'chart should fill the loss bar with the loss token',
    ).toBeVisible();

    // --- (b) Drawer Quick Stats — Avg Win (gain) + Avg Loss (loss) numerics ---
    await page.getByRole('button', { name: /open side drawer/i }).click();
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
    await page.getByRole('tab', { name: /quick stats/i }).click();
    const avgWin = page.getByTestId('quick-stats-avg-win-value').getByTestId('numeric');
    const avgLoss = page.getByTestId('quick-stats-avg-loss-value').getByTestId('numeric');
    await expect(avgWin).toHaveAttribute('data-state', 'gain');
    await expect(avgWin).toContainText(SIGN_GAIN);
    await expect(avgWin).toHaveClass(/text-gain/);
    await expect(avgLoss).toHaveAttribute('data-state', 'loss');
    await expect(avgLoss).toContainText(SIGN_LOSS);
    await expect(avgLoss).toHaveClass(/text-loss/);

    // --- (c) Positions table — a gain row and a loss row P&L numeric ---
    await page.goto('/positions');
    await expect(page.getByRole('heading', { name: 'Positions' })).toBeVisible();
    // Scope to the P&L cell of each row by symbol so the assertion is
    // unambiguous. The row now carries several Numerics (entry/target/exit
    // prices, R/R, unit counts), so target the P&L cell via its testid rather
    // than the first Numeric in the row.
    const gainNumeric = page
      .getByRole('row', { name: /GAINR/ })
      .getByTestId('position-pnl')
      .getByTestId('numeric');
    const lossNumeric = page
      .getByRole('row', { name: /LOSSR/ })
      .getByTestId('position-pnl')
      .getByTestId('numeric');
    await expect(gainNumeric).toHaveAttribute('data-state', 'gain');
    await expect(gainNumeric).toContainText(SIGN_GAIN);
    await expect(gainNumeric).toHaveClass(/text-gain/);
    await expect(lossNumeric).toHaveAttribute('data-state', 'loss');
    await expect(lossNumeric).toContainText(SIGN_LOSS);
    await expect(lossNumeric).toHaveClass(/text-loss/);

    // --- (d) Advisor surface — re-themes under .dark (token resolution) ---
    // The advisor's money figures are LLM-AUTHORED MARKDOWN PROSE, not a
    // structured Numeric render, and a live assistant reply is not
    // deterministically reachable in e2e (there is no out-of-process LLM stub —
    // see advisor-tools.spec.ts header). So the advisor surface is asserted via
    // TOKEN RESOLUTION (the part-1 "key surfaces resolve dark token values"
    // guarantee): the advisor route mounts and resolves the dark background
    // token, proving it participates in the `.dark` substrate. The leading-sign
    // ENCODING is fully proven above on the three structured-figure surfaces
    // (table, drawer, chart) that own the money-direction primitive.
    await page.goto('/advisor');
    await expect(page.locator('[data-slot="advisor-page"]')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
    const advisorBg = await resolvedBackground(page);
    expect(lightnessOf(advisorBg), `advisor should resolve a dark bg: ${advisorBg}`).toBeLessThan(
      0.3,
    );
  });
});

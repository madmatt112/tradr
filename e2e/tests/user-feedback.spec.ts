import { gunzipSync } from 'node:zlib';

import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';

import { expectPromptClearOfEveryControl, findCoveredControls } from '../support/popover-clearance';

/**
 * user-feedback e2e suite (Task 13; design Component 9, REQ-10.3/10.4/10.5).
 *
 * The composed feedback surface is exercised end-to-end against the booted
 * static SPA. The harness, in the order the pieces arm (design Component 9):
 *
 *  1. Config injection — `page.route` fulfilling `/config.js`, matched on
 *     `url.pathname === '/config.js'` so it never steals the SDK's own
 *     remote-config script at `/__ph/array/<token>/config.js` (a bare
 *     `**​/config.js` glob matches that too, so the handler falls back for it).
 *     The injected config CONFIGURES the feedback survey (a `feedbackSurvey`
 *     triple + a public key) and points every SDK endpoint at
 *     `window.location.origin + '/__ph'` — a LOCAL path the SPA never routes —
 *     so no vendor hostname appears in this file and no test touches a live
 *     vendor.
 *  2. SDK stub — one `page.route('**​/__ph/**')` answering the assets scripts,
 *     the remote-config JSON, `/flags/` and `/e/` with `200`, logging every
 *     routed request (and decoding every `/e/` batch it sees).
 *  3. Bot-gate lift — `addInitScript` redefining `Navigator.prototype.webdriver`
 *     to `false`. `capture()` drops every event while `navigator.webdriver` is
 *     true, which it is in both Playwright projects. This use of `addInitScript`
 *     is deliberate; CONFIG injection is the one that must be `page.route`. It
 *     suffices only because both projects carry a device descriptor that
 *     replaces the headless UA (`Desktop Chrome`, `iPhone 13`) — a
 *     descriptor-less project would be dropped at the UA check regardless.
 *  4. Presence canary before every absence — first await a routed `/e/` request
 *     whose PARSED body carries `$pageview` or `survey shown`, by path, with a
 *     timeout above the 3 s flush; only then assert something is absent.
 *  5. Auth — API register with a unique per-spec `X-Forwarded-For` third octet
 *     (the `/register` 5/15-min limit; convention at dashboard.spec.ts:36-69),
 *     then UI login.
 *
 * Decoding `/e/` batches BRANCHES ON THE `compression` QUERY PARAMETER (this is
 * the Playwright layer — `page.route` sees the request URL): gunzip only when it
 * says `gzip-js`, otherwise the (uncompressed) text is parsed directly. Never an
 * unconditional gunzip; never a try/gunzip/catch/raw. The `{}` remote-config
 * stub resets `supportedCompression`, so batches here are plain JSON — the gzip
 * branch is carried for correctness, not because it fires.
 *
 * The unconfigured invariant (no config, no SDK, no telemetry request) stays in
 * observability.spec.ts and is untouched by this file (REQ-10.5).
 */

// ---------------------------------------------------------------------------
// Fixtures — survey ids, selectors, credentials.
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

// Fixed UUID-shaped literals (Component 9). Three ':'-separated, non-empty,
// whitespace-free segments — exactly what `getFeedbackSurveyIds` accepts.
const SURVEY_ID = '00000000-0000-4000-8000-0000000000a1';
const RATING_QID = '00000000-0000-4000-8000-0000000000b2';
const TEXT_QID = '00000000-0000-4000-8000-0000000000c3';
const FEEDBACK_SURVEY = `${SURVEY_ID}:${RATING_QID}:${TEXT_QID}`;
// The two keyed response properties the sent payload carries.
const RATING_RESPONSE_KEY = `$survey_response_${RATING_QID}`;
const TEXT_RESPONSE_KEY = `$survey_response_${TEXT_QID}`;

const TAB = '[data-testid="feedback-tab"]';
const POPOVER = '[data-testid="feedback-popover"]';
const DRAWER_STORAGE_KEY = 'tradr_drawer_state';

// The drawer's five header controls — the popover-clearance named set (REQ-3.6).
const DRAWER_NAMED_CONTROLS = [
  'drawer-tab-open-positions',
  'drawer-tab-quick-stats',
  'drawer-tab-options-pricing',
  'drawer-tab-recently-created',
  'drawer-close',
] as const;

/**
 * A unique, non-loopback IP per register/login. The `/register` route is
 * rate-limited per client IP; the harness trusts loopback (TRUSTED_PROXIES),
 * so the limiter keys off this forwarded IP. Third octet 140 is reserved for
 * this spec — every other e2e suite owns a different one (see the convention at
 * dashboard.spec.ts:36-69).
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.140.${ipCounter % 254}`;
}

function uniqueEmail(label: string): string {
  return `e2e-feedback-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

interface SeededUser {
  email: string;
  userId: string;
  accountId: string;
}

/**
 * Register via the API (sets the session cookie on `req`), then create one
 * account and mark onboarding done — the same past-onboarding shape
 * dashboard.spec.ts seeds, so /dashboard mounts the widget grid (not the
 * zero-state) and /settings/profile renders normally.
 */
async function registerUser(req: APIRequestContext, label: string): Promise<SeededUser> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  const body = (await res.json()) as { user: { id: string } };

  const accountRes = await req.post('/api/accounts', {
    data: { name: `${label} account`, currency: 'USD' },
  });
  expect(accountRes.status(), `POST /accounts for ${email}`).toBe(201);
  const account = (await accountRes.json()) as { id: string };

  const onboardingRes = await req.patch('/api/users/me/onboarding', {
    data: { status: 'done' },
  });
  expect(onboardingRes.status(), `PATCH onboarding for ${email}`).toBe(200);

  return { email, userId: body.user.id, accountId: account.id };
}

/** Seed one OPEN position so the drawer's Open Positions tab has a row to inspect. */
async function seedOpenPosition(req: APIRequestContext, accountId: string): Promise<void> {
  const symbol = `FBK${Math.floor(Math.random() * 1e6)}`;
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol, side: 'long', assetType: 'stock' },
  });
  expect(posRes.status(), 'POST /positions').toBe(201);
  const position = (await posRes.json()) as { id: string };
  const fillRes = await req.post(`/api/positions/${position.id}/fills`, {
    data: {
      type: 'entry',
      price: '150.00',
      quantity: '10',
      fees: '1.00',
      filledAt: '2026-05-01T14:30:00.000Z',
    },
  });
  expect(fillRes.status(), 'POST entry fill').toBe(201);
  const openRes = await req.post(`/api/positions/${position.id}/open`, { data: {} });
  expect(openRes.status(), 'POST /positions/:id/open').toBe(200);
}

async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Skip gracefully when the stack is not booted (mirrors the other live suites). */
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

// ---------------------------------------------------------------------------
// The routed-request log + `/e/` decoding.
// ---------------------------------------------------------------------------

type PhEvent = Record<string, unknown> & { event?: string; properties?: Record<string, unknown> };

interface RoutedRequest {
  pathname: string;
  method: string;
  events: PhEvent[];
}

/**
 * Events out of an ALREADY-decompressed batch body. posthog-js wraps the array
 * in one of a few envelopes; parse the JSON, and fall back to the form-encoded
 * `data=<json>` shape (mirrors posthog.leak.test.ts's `eventsFrom`). This is
 * envelope parsing, NOT decompression — the gzip decision happens once, above,
 * on the `compression` query parameter.
 */
function eventsFromText(text: string): PhEvent[] {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  // The batch text is either raw JSON or the form-encoded `data=<payload>` shape,
  // where the payload is JSON or base64-of-JSON (posthog-js's uncompressed body).
  let parsed = tryParse(text);
  if (parsed === undefined) {
    const data = new URLSearchParams(text).get('data');
    if (data) {
      parsed = tryParse(data) ?? tryParse(Buffer.from(data, 'base64').toString('utf8'));
    }
  }
  if (parsed === undefined) return [];
  if (Array.isArray(parsed)) return parsed as PhEvent[];
  if (parsed && typeof parsed === 'object') {
    const batch = (parsed as { batch?: unknown }).batch;
    if (Array.isArray(batch)) return batch as PhEvent[];
    return [parsed as PhEvent];
  }
  return [];
}

/** Decode one `/e/` request body, branching on its `compression` query param. */
function decodeBatch(request: Request): PhEvent[] {
  const url = new URL(request.url());
  const buf = request.postDataBuffer();
  if (buf === null) return [];
  const text =
    url.searchParams.get('compression') === 'gzip-js'
      ? gunzipSync(buf).toString('utf8')
      : buf.toString('utf8');
  return eventsFromText(text);
}

interface Harness {
  routed: RoutedRequest[];
  /** Every event across every routed `/e/` batch, flattened. */
  allEvents(): PhEvent[];
  /** Only the survey events (`survey shown|sent|dismissed`). */
  surveyEvents(): PhEvent[];
  /** Await a routed `/e/` event matching `match` (by path, timeout above 3 s flush). */
  waitForEvent(match: (e: PhEvent) => boolean, label: string, timeout?: number): Promise<void>;
}

/**
 * Arm the whole harness on `page` (call BEFORE the first navigation): bot-gate
 * lift, the SDK stub, and the `/config.js` injection (registered LAST so
 * Playwright tries it first and it cleanly falls back for the SDK's own
 * remote-config script).
 */
async function installFeedbackHarness(page: Page): Promise<Harness> {
  const routed: RoutedRequest[] = [];

  // (3) Bot-gate lift — before any navigation, so it precedes SDK init.
  // `capture()` drops every event when `_is_bot()` is true, and it reads BOTH
  // `navigator.webdriver` AND `navigator.userAgentData.brands` — which, on a real
  // http(s) page under headless Chromium, carries a "HeadlessChrome" brand that
  // matches the SDK's default blocked-UA list (the device's clean UA STRING is
  // not enough). Neutralise both. The brands override MUST be on the prototype:
  // `navigator.userAgentData` returns a fresh object on every access, so an
  // instance-level defineProperty is silently futile.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      get: () => false,
    });
    try {
      const uaData = (
        navigator as unknown as { userAgentData?: { brands: Array<{ brand: string }> } }
      ).userAgentData;
      if (uaData && Array.isArray(uaData.brands)) {
        const clean = uaData.brands.filter((b) => !/headless/i.test(b?.brand ?? ''));
        Object.defineProperty(Object.getPrototypeOf(uaData), 'brands', {
          configurable: true,
          get: () => clean,
        });
      }
    } catch {
      /* userAgentData absent (WebKit) — its UA string carries no Headless brand */
    }
  });

  // (2) SDK stub. Registered first; the config route below falls back to it for
  // `/__ph/array/<token>/config.js`.
  await page.route('**/__ph/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const entry: RoutedRequest = { pathname: url.pathname, method: request.method(), events: [] };
    if (url.pathname.includes('/e/') && request.method() === 'POST') {
      entry.events = decodeBatch(request);
    }
    routed.push(entry);
    if (url.pathname.endsWith('.js')) {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    } else if (url.pathname.includes('/e/')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":1}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  // (1) Config injection — matched on the exact pathname, never the SDK script.
  await page.route('**/config.js', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/config.js') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body:
        'window.__TRADR_CONFIG__ = {' +
        ' posthogPublicKey: "phc_e2e_feedback",' +
        // Local origin + a path the SPA never routes: every SDK endpoint resolves
        // here, so no vendor hostname is named in this file.
        ' posthogPublicHost: window.location.origin + "/__ph",' +
        ' posthogPublicEnvironment: "e2e",' +
        ` feedbackSurvey: ${JSON.stringify(FEEDBACK_SURVEY)}` +
        ' };',
    });
  });

  const allEvents = (): PhEvent[] => routed.flatMap((r) => r.events);
  const isSurvey = (e: PhEvent): boolean =>
    e.event === 'survey shown' || e.event === 'survey sent' || e.event === 'survey dismissed';

  return {
    routed,
    allEvents,
    surveyEvents: () => allEvents().filter(isSurvey),
    async waitForEvent(match, label, timeout = 12_000) {
      await expect
        .poll(() => allEvents().some(match), {
          message: `waiting for routed /e/ event: ${label}`,
          timeout,
          intervals: [200, 400, 800, 1200],
        })
        .toBe(true);
    },
  };
}

/** The presence canary: a routed `/e/` batch carrying `$pageview` or `survey shown`. */
async function awaitCanary(h: Harness): Promise<void> {
  await h.waitForEvent(
    (e) => e.event === '$pageview' || e.event === 'survey shown',
    '$pageview | survey shown (canary)',
  );
}

async function openDrawerViaToggle(page: Page): Promise<void> {
  await page.getByRole('button', { name: /open side drawer/i }).click();
  await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
}

async function openPopover(page: Page): Promise<void> {
  await page.locator(TAB).click();
  await expect(page.getByTestId('feedback-popover')).toBeVisible();
}

// ===========================================================================
// Desktop suite (chromium project) — 1280×720 unless a case resizes.
// ===========================================================================

test.describe('user feedback — desktop', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // Presence — the tab is on the authenticated routes.
  // -------------------------------------------------------------------------
  test('tab present on /dashboard and /settings/profile', async ({ page, request }) => {
    await installFeedbackHarness(page);
    const user = await registerUser(request, 'presence');
    await loginViaUi(page, user.email);

    await expect(page.getByTestId('feedback-tab')).toBeVisible();

    await page.goto('/settings/profile');
    await expect(page.getByTestId('feedback-tab')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Absence — no tab on the public routes, even with config injected (they
  // render outside _auth). Run UNAUTHENTICATED so /login etc. do not redirect.
  // -------------------------------------------------------------------------
  test('no tab on /login, /register, /reset-password (config injected)', async ({ page }) => {
    await installFeedbackHarness(page);
    // reset-password renders its own view only with a token in the URL.
    for (const route of ['/login', '/register', '/reset-password?token=deadbeefdeadbeef']) {
      await page.goto(route);
      // The SPA has mounted its route view (test 1 already proves the harness DOES
      // paint the tab on an _auth route, so this absence is not vacuous).
      await expect(page.locator('#root')).not.toBeEmpty();
      await expect(page.getByTestId('feedback-tab')).toHaveCount(0);
    }
  });

  // -------------------------------------------------------------------------
  // Geometry — the 360 px shift with the drawer open, and the return on close.
  // -------------------------------------------------------------------------
  test('tab shifts 360 px with the drawer open and returns on close (1280)', async ({
    page,
    request,
  }) => {
    await installFeedbackHarness(page);
    const user = await registerUser(request, 'geometry');
    await loginViaUi(page, user.email);
    await expect(page.getByTestId('feedback-tab')).toBeVisible();

    const closedBox = await page.locator(TAB).boundingBox();
    expect(closedBox).not.toBeNull();

    await openDrawerViaToggle(page);
    // The tab settles flush against the drawer's outer (left) edge (REQ-3.1).
    // Both are `fixed right-0`, so this comparison is scrollbar-independent —
    // unlike an absolute 360 px delta, which a reflow-driven scrollbar change
    // would skew. Poll so the 200 ms slide-in (tab and drawer animate together)
    // has finished before the flush is judged.
    await expect
      .poll(
        async () => {
          const t = await page.locator(TAB).boundingBox();
          const d = await page.getByTestId('side-drawer').boundingBox();
          if (!t || !d) return Number.POSITIVE_INFINITY;
          return Math.abs(t.x + t.width - d.x);
        },
        { timeout: 3_000 },
      )
      .toBeLessThanOrEqual(2);
    // And it has genuinely shifted left from its closed position.
    const openBox = await page.locator(TAB).boundingBox();
    expect(openBox!.x).toBeLessThan(closedBox!.x - 300);

    // Close via the drawer's own control (the toggle is hidden while open) — the
    // tab returns to its viewport-edge position.
    await page.getByTestId('drawer-close').click();
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'closed');
    await expect
      .poll(async () => (await page.locator(TAB).boundingBox())?.x ?? Number.NEGATIVE_INFINITY)
      .toBeGreaterThan(closedBox!.x - 5);
  });

  // -------------------------------------------------------------------------
  // REQ-3.3 — at 900×720 the backdrop and the shift coexist; the tab stays
  // interactive and a click on it does not close the drawer.
  // -------------------------------------------------------------------------
  test('at 900×720 the tab shifts above the backdrop and its click keeps the drawer open', async ({
    page,
    request,
  }) => {
    await installFeedbackHarness(page);
    await page.setViewportSize({ width: 900, height: 720 });
    const user = await registerUser(request, 'backdrop');
    await loginViaUi(page, user.email);

    await openDrawerViaToggle(page);
    // Backdrop present (md–lg band) and the tab shifted above it, still visible.
    await expect(page.getByTestId('drawer-backdrop')).toBeVisible();
    await expect(page.locator(TAB)).toBeVisible();

    // A click on the tab opens the popover and must NOT close the drawer.
    await openPopover(page);
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
  });

  // -------------------------------------------------------------------------
  // Escape stacking + focus return + aria pairing (REQ-4.7, scoped).
  // -------------------------------------------------------------------------
  test('Escape closes the popover then the inspect drawer; focus returns to the tab', async ({
    page,
    request,
  }) => {
    await installFeedbackHarness(page);
    const user = await registerUser(request, 'escape');
    await seedOpenPosition(request, user.accountId);
    await loginViaUi(page, user.email);

    // Inspect a position row on the /positions page (its PositionList is the one
    // surface that opens the drawer straight into the inspect panel). A click on
    // the P&L cell — not the symbol link — routes to inspectPosition; the inspect
    // surface's close control, not the tab header, is what Escape must reach.
    await page.goto('/positions');
    const pnl = page.getByTestId('position-pnl').first();
    await expect(pnl).toBeVisible();
    await pnl.click();
    await expect(page.locator('[data-slot="inspect-close"]')).toBeVisible();

    await openPopover(page);

    // aria pairing — resolve the trigger's aria-controls to the popover element
    // (never asserted via a custom content id; colons in the Radix id force an
    // attribute selector, not `#id`).
    const controls = await page.locator(TAB).getAttribute('aria-controls');
    expect(controls, 'trigger aria-controls').toBeTruthy();
    await expect(page.locator(`[id="${controls}"]`)).toHaveAttribute(
      'data-testid',
      'feedback-popover',
    );

    // Escape 1 — popover closes, the inspect drawer stays, focus back on the tab.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('feedback-popover')).toHaveCount(0);
    await expect(page.locator('[data-slot="inspect-close"]')).toBeVisible();
    await expect(page.locator(TAB)).toBeFocused();

    // Escape 2 — the inspect drawer closes.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'closed');
  });

  // -------------------------------------------------------------------------
  // A programmatic drawer change closes the popover as a dismissal (deviation 3).
  // -------------------------------------------------------------------------
  test('a synthetic cross-tab drawer-open closes the popover and captures a dismissal', async ({
    page,
    request,
  }) => {
    test.setTimeout(45_000);
    const h = await installFeedbackHarness(page);
    const user = await registerUser(request, 'progchange');
    await loginViaUi(page, user.email);
    await awaitCanary(h);

    await openPopover(page);
    await h.waitForEvent((e) => e.event === 'survey shown', 'survey shown');

    // Dispatch a cross-tab storage change — the shipped handler needs only
    // key + newValue. Drawer opens (snaps), the tab shifts, the popover closes.
    await page.evaluate((key) => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key,
          newValue: JSON.stringify({ isOpen: true, activeTab: 'open-positions', version: 1 }),
        }),
      );
    }, DRAWER_STORAGE_KEY);

    await expect(page.getByTestId('feedback-popover')).toHaveCount(0);
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');

    // The dismissal lands in a SUBSEQUENT /e/ batch (wait by path, not "next").
    await h.waitForEvent(
      (e) =>
        e.event === 'survey dismissed' &&
        (e.properties?.['$survey_id'] as string) === SURVEY_ID &&
        typeof e.properties?.['$survey_submission_id'] === 'string',
      'survey dismissed (programmatic)',
    );
  });

  // -------------------------------------------------------------------------
  // Wire contract — no capture on mount; the sent payload keeps the .csv and
  // redacts the secret; the sent-timer close returns focus to the tab; a
  // close-without-send is a text-less dismissal; no survey storage/bundle after.
  // -------------------------------------------------------------------------
  test('sent payload keeps the .csv and redacts the secret; dismissal carries no text', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const h = await installFeedbackHarness(page);
    const user = await registerUser(request, 'wire');
    await loginViaUi(page, user.email);
    await awaitCanary(h);

    // No capture on mount — no survey event before the popover ever opened.
    expect(h.surveyEvents(), 'no survey event on mount').toEqual([]);

    // Open → rate → type (a .csv filename + an sk- secret) → Send.
    await openPopover(page);
    await page.getByRole('radio', { name: '3' }).click();
    await page
      .getByLabel('Details (optional)')
      .fill('import broke on report-2024.csv key sk-abc123XYZ456');
    // `exact` so the name does not also match the tab (aria-label "Send feedback").
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Sent. Thank you.')).toBeVisible();

    await h.waitForEvent((e) => e.event === 'survey sent', 'survey sent');
    const sent = h.allEvents().find((e) => e.event === 'survey sent');
    expect(sent, 'survey sent event present').toBeTruthy();
    const props = sent!.properties ?? {};
    expect(props['$survey_id']).toBe(SURVEY_ID);
    expect(typeof props['$survey_submission_id']).toBe('string');
    expect(props['$survey_completed']).toBe(true);
    expect(props[RATING_RESPONSE_KEY]).toBe(3);
    const answer = props[TEXT_RESPONSE_KEY] as string;
    // The .csv filename survives; the secret is redacted; the raw key is gone.
    expect(answer).toContain('report-2024.csv');
    expect(answer).toContain('[redacted]');
    expect(answer).not.toContain('sk-abc123XYZ456');

    // The 3 s sent-timer close returns focus to the tab (a genuine Radix path).
    await expect(page.getByTestId('feedback-popover')).toHaveCount(0, { timeout: 8_000 });
    await expect(page.locator(TAB)).toBeFocused();

    // Open → close-without-send ⇒ survey dismissed, no text under any key.
    await openPopover(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('feedback-popover')).toHaveCount(0);
    await h.waitForEvent((e) => e.event === 'survey dismissed', 'survey dismissed');
    const dismissed = h.allEvents().find((e) => e.event === 'survey dismissed');
    const dProps = dismissed!.properties ?? {};
    expect(Object.keys(dProps)).toEqual(
      expect.arrayContaining(['$survey_id', '$survey_submission_id']),
    );
    expect(dProps[TEXT_RESPONSE_KEY]).toBeUndefined();
    for (const key of Object.keys(dProps)) {
      expect(key.startsWith('$survey_response'), `dismissed carries no response key (${key})`).toBe(
        false,
      );
    }

    // Storage/bundle absence — after the flow, after the canary.
    const surveyKeys = await page.evaluate(() =>
      Object.keys(window.localStorage).filter(
        (k) =>
          k.startsWith('seenSurvey_') ||
          k.startsWith('inProgressSurvey_') ||
          k.startsWith('abandonedSurvey_') ||
          k === 'lastSeenSurveyDate',
      ),
    );
    expect(surveyKeys, 'no survey localStorage keys persist').toEqual([]);
    expect(
      h.routed.filter((r) => /surveys/i.test(r.pathname)).map((r) => r.pathname),
      'no surveys bundle requested',
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Clearance — the tab is clear of every control it could overlap.
  // -------------------------------------------------------------------------
  test('the tab clears every control on /dashboard and /calculator, drawer closed and open', async ({
    page,
    request,
  }) => {
    await installFeedbackHarness(page);
    const user = await registerUser(request, 'clearance-tab');
    await loginViaUi(page, user.email);

    const sweep = async (route: string, drawerOpen: boolean): Promise<void> => {
      await page.goto(route);
      await page.evaluate(
        ({ key, open }) => {
          if (open) {
            window.localStorage.setItem(
              key,
              JSON.stringify({ isOpen: true, activeTab: 'open-positions', version: 1 }),
            );
          } else {
            window.localStorage.removeItem(key);
          }
        },
        { key: DRAWER_STORAGE_KEY, open: drawerOpen },
      );
      await page.reload();
      await expect(page.locator(TAB)).toBeVisible();
      if (drawerOpen) {
        await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
      }
      await expectPromptClearOfEveryControl(
        page,
        TAB,
        `feedback tab on ${route} (drawer ${drawerOpen ? 'open' : 'closed'})`,
      );
    };

    for (const route of ['/dashboard', '/calculator']) {
      await sweep(route, false);
      await sweep(route, true);
    }
  });

  // -------------------------------------------------------------------------
  // Clearance — the OPEN popover covers none of the named set (the drawer's
  // five header controls + the tab). The controls must be VISIBLE first, or a
  // closed (aria-hidden) drawer makes the assertion vacuous.
  // -------------------------------------------------------------------------
  test('the open popover covers none of the drawer header controls or the tab', async ({
    page,
    request,
  }) => {
    await installFeedbackHarness(page);
    const user = await registerUser(request, 'clearance-pop');
    await loginViaUi(page, user.email);

    // Drawer open in TAB mode so its header controls are real (non-aria-hidden)
    // sweep candidates, then open the popover beside the tab.
    await openDrawerViaToggle(page);
    for (const testid of DRAWER_NAMED_CONTROLS) {
      await expect(page.getByTestId(testid)).toBeVisible();
    }
    await openPopover(page);

    const hits = await findCoveredControls(page, POPOVER);
    const namedHits = hits.filter(
      (hit) =>
        DRAWER_NAMED_CONTROLS.some((id) => hit.what.includes(`[data-testid="${id}"]`)) ||
        hit.what.includes('[data-testid="feedback-tab"]'),
    );
    expect(
      namedHits,
      `the popover covers a named control:\n${namedHits.map((h) => `  • ${h.what}`).join('\n')}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// Mobile suite (Mobile Chrome project — iPhone 13, WebKit, 390 px, coarse).
// ===========================================================================

test.describe('user feedback — mobile', () => {
  test.skip(
    ({ isMobile }) => !isMobile,
    'Mobile-only suite — runs under the Mobile Chrome project.',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // REQ-3.4 — below md the tab is gone while the drawer is open and returns
  // when it closes; and REQ-2.2's 44 px coarse-pointer <main> gutter.
  // -------------------------------------------------------------------------
  test('below md: tab hidden with the drawer open, back on close; 44 px main gutter', async ({
    page,
    request,
  }) => {
    await installFeedbackHarness(page);
    const user = await registerUser(request, 'mobile');
    await loginViaUi(page, user.email);

    // Configured coarse gutter: <main> yields 44 px on the right (drawer closed).
    await expect(page.locator(TAB)).toBeVisible();
    const gutter = await page.locator('main').evaluate((el) => getComputedStyle(el).paddingRight);
    expect(gutter).toBe('44px');

    // Drawer open (full width below md) ⇒ the tab is removed, not merely covered.
    // dispatchEvent (not .click()) fires the inline toggle's onClick without the
    // auto-scroll a real click would trigger on the off-screen control.
    await page.getByRole('button', { name: /open side drawer/i }).dispatchEvent('click');
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
    await expect(page.locator(TAB)).toBeHidden();

    // Close (mobile drawer honours Escape) ⇒ the tab returns.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'closed');
    await expect(page.locator(TAB)).toBeVisible();
  });
});

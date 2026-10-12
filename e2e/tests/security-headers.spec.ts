import crypto from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { STUB_MODEL_ID, STUB_REPLY_TEXT } from '../support/openai-stub-server';

/**
 * security-headers e2e suite (security-hardening Task 22; design C10/C11,
 * Requirement 6.10).
 *
 * Proves the enforcing Content-Security-Policy end to end against the booted
 * self-host stack. The Playwright web server builds the SPA and serves it through
 * `vite preview` (e2e/playwright.config.ts): the CSP plugin's
 * `configurePreviewServer` (apps/web/scripts/csp-plugin.mjs) sets the SAME policy
 * nginx ships in production — `script-src 'self' '<boot-theme hash>'` with no
 * `'unsafe-inline'`/`'unsafe-eval'`, `connect-src 'self'`, `frame-ancestors
 * 'none'` — plus the four static security headers, on every non-/api/ response.
 *
 * ── Driving the app, not injecting behaviour ───────────────────────────────
 *
 * The violation collector is a passive `securitypolicyviolation` listener armed
 * through `addInitScript` (so it re-arms on every navigation); it records what
 * the browser reports, never provokes it. Its first use is a NEGATIVE CONTROL: a
 * page-created inline script the enforcing policy must block — proving the
 * collector actually fires before any "no violation" assertion is trusted.
 *
 * PostHog is initialised through the app's own gated path (main.tsx →
 * initPostHogClient), keyed by injecting `/config.js` exactly as
 * user-feedback.spec.ts:282-319 does and pointing every SDK endpoint at the
 * SAME-ORIGIN `/__ph` host, so `connect-src 'self'` admits it with no vendor
 * origin named. The advisor reply streams from the out-of-process OpenAI-shaped
 * stub the advisor-tools suite boots (e2e/support/openai-stub-server.ts) — the
 * browser only ever talks to same-origin `/api`. The service worker registers
 * through the app's own load-time registration (pwa.spec.ts:46,75-81), never a
 * test-side `register()`.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  // crypto.randomUUID() — a unique value without Math.random() (CodeQL).
  return `e2e-sec-${label}-${crypto.randomUUID()}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login. The auth `/register` route is
 * rate-limited per client IP; the harness trusts loopback
 * (`TRUSTED_PROXIES=127.0.0.1`, playwright.config.ts), so the limiter keys off
 * this forwarded IP. Third octet 145 is this spec's own — every other suite owns
 * a different one. `process.pid` namespaces each Playwright worker process.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.145.${ipCounter % 254}`;
}

interface SeededUser {
  email: string;
  userId: string;
  accountId: string;
}

/**
 * Register via the API (sets the session cookie on `req`), then create one
 * account and mark onboarding done — the past-onboarding shape dashboard.spec.ts
 * seeds, so /dashboard mounts the widget grid (not the zero-state) and the
 * settings/advisor pages render without the onboarding overlay. `page.request`
 * shares the browser context's cookie jar, so after this the page is signed in.
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
// The securitypolicyviolation collector.
// ---------------------------------------------------------------------------

interface CspViolation {
  violatedDirective: string;
  effectiveDirective: string;
  blockedURI: string;
}

/**
 * Arm a passive `securitypolicyviolation` collector on `window.__cspViolations`
 * (call BEFORE the first navigation). `addInitScript` re-runs on every new
 * document, so each page gets a fresh collector that records only that page's
 * violations — exactly what the per-page "no violation" assertions read.
 */
async function installViolationCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = window as unknown as { __cspViolations?: CspViolation[] };
    store.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.__cspViolations?.push({
        violatedDirective: event.violatedDirective,
        effectiveDirective: event.effectiveDirective,
        blockedURI: event.blockedURI,
      });
    });
  });
}

/** The violations the collector recorded on the current document. */
async function readViolations(page: Page): Promise<CspViolation[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations?: CspViolation[] }).__cspViolations ?? [],
  );
}

/** Assert the current document recorded no CSP violation. */
async function expectNoViolations(page: Page, label: string): Promise<void> {
  const violations = await readViolations(page);
  expect(violations, `CSP violations on ${label}: ${JSON.stringify(violations)}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// PostHog harness — the user-feedback.spec.ts:282-319 precedent, trimmed to the
// init + first-request proof. config.js points every SDK endpoint at the
// SAME-ORIGIN `/__ph` host; the stub answers them; the bot-gate lift lets
// capture() run under headless Chromium.
// ---------------------------------------------------------------------------

interface RoutedRequest {
  pathname: string;
  method: string;
}

async function installPostHogHarness(page: Page): Promise<RoutedRequest[]> {
  const routed: RoutedRequest[] = [];

  // Bot-gate lift — before any navigation, so it precedes SDK init. capture()
  // drops every event while `navigator.webdriver` is true or the UA-brands carry
  // a "HeadlessChrome" entry; neutralise both (the brands override must be on the
  // prototype — `navigator.userAgentData` returns a fresh object per access).
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

  // SDK stub — answers the SDK's own scripts, remote config, and `/e/` ingestion
  // under the same-origin `/__ph` host, logging every routed request.
  await page.route('**/__ph/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    routed.push({ pathname: url.pathname, method: request.method() });
    if (url.pathname.endsWith('.js')) {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    } else if (url.pathname.includes('/e/')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":1}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  // Config injection — matched on the exact pathname so it never steals the SDK's
  // own `/__ph/array/<token>/config.js` (a bare `**​/config.js` glob matches that
  // too, so the handler falls back for it). Every SDK endpoint resolves to
  // `window.location.origin + '/__ph'`, a same-origin path the SPA never routes,
  // so no vendor hostname is named and `connect-src 'self'` admits it.
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
        ' posthogPublicKey: "phc_e2e_sec_headers",' +
        ' posthogPublicHost: window.location.origin + "/__ph",' +
        ' posthogPublicEnvironment: "e2e"' +
        ' };',
    });
  });

  return routed;
}

// ---------------------------------------------------------------------------
// Desktop suite (chromium) — the policy, its collector, the streamed advisor
// reply, PostHog and the four-page sweep are all desktop-shaped.
// ---------------------------------------------------------------------------

test.describe('security headers — CSP end to end', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop Chromium only — the enforcing-policy sweep runs under chromium.',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('the enforcing CSP and the four static headers are served on /', async ({ page }) => {
    const response = await page.goto('/');
    expect(response, 'GET / returned a response').not.toBeNull();
    const headers = response!.headers();

    const csp = headers['content-security-policy'];
    expect(csp, 'Content-Security-Policy present on /').toBeTruthy();

    // Enforcing baseline (Req 6.2): self default, the built inline-script hash,
    // locked frames/objects/base/form, same-origin connect.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
    // No unexpanded origin placeholder reached the shipped header (Req 6.4/6.5).
    expect(csp).not.toContain('__');

    // script-src carries no unsafe source (Req 6.2) — checked on the directive
    // itself, since style-src legitimately keeps 'unsafe-inline' (D6).
    const scriptSrc = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src'));
    expect(scriptSrc, 'script-src directive present').toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");

    // The four static security headers (design C10).
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
  });

  test('the collector records a deliberate page-created inline-script violation', async ({
    page,
  }) => {
    await installViolationCollector(page);
    await page.goto('/login');

    // Negative control: a page-created inline script. script-src has no
    // 'unsafe-inline' and only the boot-theme hash, so the enforcing policy
    // blocks this and fires securitypolicyviolation — proving the collector works
    // before any "no violation" assertion below is trusted.
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__cspProbeRan = true;';
      document.body.appendChild(script);
    });

    await expect
      .poll(async () => (await readViolations(page)).length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    const violations = await readViolations(page);
    expect(
      violations.some(
        (v) =>
          v.effectiveDirective.startsWith('script-src') ||
          v.violatedDirective.startsWith('script-src'),
      ),
      `a script-src violation was recorded: ${JSON.stringify(violations)}`,
    ).toBe(true);
    // The blocked inline script never ran.
    const ran = await page.evaluate(
      () => (window as unknown as { __cspProbeRan?: boolean }).__cspProbeRan ?? false,
    );
    expect(ran).toBe(false);
  });

  test('an advisor reply streams from the stub under the enforcing policy', async ({ page }) => {
    await installViolationCollector(page);
    await registerUser(page.request, 'advisor');

    // Save a BYOK OpenAI key; the save-time probe calls listModels against the
    // stub, which returns stub-local-model, so the key verifies.
    await page.goto('/settings/advisor');
    const card = page.getByTestId('provider-key-card-openai');
    await expect(card).toBeVisible();
    await card.getByLabel('API key').fill('sk-e2e-stub-local-key');
    await card.getByRole('button', { name: 'Save key' }).click();
    await expect(card.getByText('Key verified')).toBeVisible();

    // Select the stub's conversation-only model and wait for the PATCH to land.
    await card.locator('#openai-default-model').click();
    const modelPatched = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/advisor/provider-keys/openai' &&
        res.request().method() === 'PATCH',
    );
    await page.getByRole('option', { name: STUB_MODEL_ID }).click();
    await modelPatched;
    await expect(card.locator('#openai-default-model')).toContainText(STUB_MODEL_ID);

    // Send one advisor message. The stream resolves server-side to the stub; the
    // browser's only network hop is the same-origin /api SSE (connect-src 'self').
    await page.goto('/advisor');
    const composer = page.getByTestId('composer');
    await expect(composer).toBeVisible();
    await composer.getByRole('textbox', { name: 'Message' }).fill('Give me a one-line summary.');
    await composer.getByRole('button', { name: 'Send message' }).click();

    // The fixed stub reply streams into the transcript, and nothing tripped.
    await expect(page.getByText(STUB_REPLY_TEXT)).toBeVisible();
    await expectNoViolations(page, '/advisor (streamed reply)');
  });

  test('PostHog initialises through the same-origin /__ph host and sends its first request', async ({
    page,
  }) => {
    await installViolationCollector(page);
    const routed = await installPostHogHarness(page);
    await registerUser(page.request, 'posthog');

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);

    // PostHog's remote-config fetch reaches the same-origin /__ph host, so the
    // SDK initialised under `connect-src 'self'` / `script-src 'self'`.
    await expect
      .poll(() => routed.some((r) => r.pathname.startsWith('/__ph')), { timeout: 15_000 })
      .toBe(true);
    // Its first event batch (the entry `$pageview`) is POSTed to the `/e/`
    // ingestion path — proof the SDK is sending telemetry, not merely loading.
    await expect
      .poll(() => routed.some((r) => r.method === 'POST' && r.pathname.includes('/e/')), {
        timeout: 15_000,
      })
      .toBe(true);

    await expectNoViolations(page, '/dashboard (PostHog keyed)');
  });

  test('login, dashboard, settings and advisor raise no CSP violation', async ({ page }) => {
    await installViolationCollector(page);

    // Login — the one unauthenticated route in the set.
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expectNoViolations(page, '/login');

    await registerUser(page.request, 'pages');

    for (const path of ['/dashboard', '/settings/profile', '/advisor']) {
      await page.goto(path);
      expect(page.url(), `navigated to ${path}`).toContain(path);
      // The authed app shell rendered (no redirect to /login), so the bundle's
      // scripts, styles and fonts have loaded under the enforcing policy.
      await expect(page.locator('main')).toBeVisible();
      await expectNoViolations(page, path);
    }
  });

  // -------------------------------------------------------------------------
  // Service-worker registration under the enforcing policy. serviceWorkers are
  // blocked suite-wide (playwright.config.ts) so every other spec's page.route
  // stubs reach the page; this nested block opts the worker back in exactly as
  // pwa.spec.ts:46 does.
  // -------------------------------------------------------------------------
  test.describe('with the service worker enabled', () => {
    test.use({ serviceWorkers: 'allow' });

    test('the service worker registers under the enforcing policy', async ({ page }) => {
      await installViolationCollector(page);
      await page.goto('/');

      // The PRODUCTION app's own load-time registration (main.tsx →
      // registerServiceWorker), never a test-side register(). worker-src 'self'
      // admits the same-origin /sw.js.
      const hasActiveWorker = await page.evaluate(() =>
        navigator.serviceWorker.ready.then((registration) => registration.active !== null),
      );
      expect(hasActiveWorker).toBe(true);
      await expectNoViolations(page, '/ (service worker)');
    });
  });
});

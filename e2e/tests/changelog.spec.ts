import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * changelog e2e suite (Task 14).
 *
 * Per design Component 10: against the booted stack, with the GitHub releases
 * stub (e2e/support/github-stub-server.ts) wired via the REQ-3.6 seam
 * (`CHANGELOG_GITHUB_BASE_URL` → the stub; see e2e/playwright.config.ts). The
 * stub serves two fixture releases (one prerelease; GFM table + inline
 * <script> bodies) with timestamps fixed in the past, and a `POST /__mode`
 * failure toggle (`ok` | `fail`) — new surface this spec adds (the uw-stub has
 * no failure toggle).
 *
 * Scenarios:
 *   1. render — both releases newest-first, formatted markdown (GFM table),
 *      the Pre-release label, GitHub links; inline HTML appears as TEXT
 *      (sanitize property end-to-end).
 *   2. badge ABSENCE + nav correctness — a freshly registered user sees the
 *      Changelog nav link with no badge (every fixture release predates the
 *      account-creation floor — deterministic regardless of when the suite
 *      warmed the cache), opens the page, releases render, badge stays absent
 *      after reload.
 *   3. upstream-down resilience — `POST /__mode fail`, reload → the page still
 *      renders releases (served from the API's process-local cache).
 *
 * ── The badge appear→visit→clear lifecycle is deliberately NOT here ────────
 *
 * The releases cache is process-wide and Playwright boots ONE API process for
 * the whole suite: earlier-alphabetical specs warm the cache with fixture
 * timestamps that predate this spec's mid-suite registrations, so under the
 * account-creation floor the badge can never deterministically appear within
 * the TTL. The lifecycle is owned where module state is controllable — the
 * integration layer (changelog.test.ts floor tests) and the web layer
 * (hasNewReleases / mark-viewed / Sidebar badge tests). No test-only
 * cache-reset endpoint exists, by design.
 */

// Standalone Playwright CLI context — same `process.env` carve-out as
// playwright.config.ts (no `@/lib/config` in scope here).
/* eslint-disable no-restricted-syntax */
const GITHUB_STUB_URL = `http://localhost:${Number(process.env.GITHUB_STUB_PORT ?? 4601)}`;
/* eslint-enable no-restricted-syntax */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-changelog-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register call (the admin-platform.spec.ts
 * idiom): `/register` is rate-limited per client IP and the harness trusts the
 * loopback proxy, so a unique `X-Forwarded-For` dodges the shared bucket.
 * The distinct 3rd octet differs from the other suites' so files never collide.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // process.pid namespaces each Playwright worker process — the chromium +
  // Mobile Chrome projects re-run this spec in fresh workers that reset
  // ipCounter, so without it the low IPs replay and accumulate past the
  // /register limit (5 / 15 min). The distinct 3rd octet separates specs.
  return `10.${process.pid % 256}.116.${ipCounter % 254}`;
}

async function registerUser(req: APIRequestContext, label: string): Promise<string> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
}

/** Probe the stack — skip gracefully when no booted stack is reachable. */
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

async function setStubMode(req: APIRequestContext, mode: 'ok' | 'fail'): Promise<void> {
  const res = await req.post(`${GITHUB_STUB_URL}/__mode`, { data: { mode } });
  expect(res.status(), `stub mode → ${mode}`).toBe(200);
}

/**
 * Navigate and wait for the sidebar's releases query to settle, so badge
 * absence is asserted against real data — never vacuously against a query
 * that has not resolved yet.
 */
async function gotoAndAwaitReleases(page: Page, path: string): Promise<void> {
  const releasesResponse = page.waitForResponse(
    (res) => res.url().includes('/api/changelog/releases') && res.request().method() === 'GET',
  );
  await page.goto(path);
  const res = await releasesResponse;
  expect(res.status()).toBe(200);
}

test.describe('changelog', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
    // Reset the failure toggle so each test (and each retry) starts from a
    // healthy upstream regardless of what a previous run left behind.
    await setStubMode(page.request, 'ok');
  });

  test('renders both releases newest-first with markdown, prerelease label, and safe links', async ({
    page,
  }) => {
    await registerUser(page.request, 'render');
    await page.goto('/changelog');
    await expect(page.getByRole('heading', { name: 'Changelog' })).toBeVisible();

    // Both fixture releases render newest-first (the stub lists them
    // oldest-first, so this exercises the API's server-side sort).
    const cards = page.locator('[data-slot="card"]');
    await expect(cards).toHaveCount(2);
    const newest = cards.nth(0);
    const oldest = cards.nth(1);
    await expect(newest.getByText('v0.2.0 — Beta improvements')).toBeVisible();
    await expect(oldest.getByText('v0.1.0 — First release')).toBeVisible();

    // Prerelease label only on the flagged release (REQ-4.4).
    await expect(newest.getByText('Pre-release')).toBeVisible();
    await expect(oldest.getByText('Pre-release')).toHaveCount(0);

    // GFM table renders as a real table (REQ-4.3).
    const table = newest.locator('table');
    await expect(table).toBeVisible();
    await expect(table.locator('th').nth(0)).toHaveText('Feature');
    await expect(table.locator('th').nth(1)).toHaveText('Status');
    await expect(table.getByText('Changelog page')).toBeVisible();

    // Sanitize property end-to-end: the fixture's inline <script> never becomes
    // live markup — its inner text renders as plain text, no script element
    // mounts inside the card, and the would-be payload never executed.
    await expect(oldest.getByText('window.__changelogXss = true')).toBeVisible();
    await expect(oldest.locator('script')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as { __changelogXss?: unknown }).__changelogXss),
    ).toBeUndefined();

    // External GitHub links (REQ-4.2) — fixture html_url values are real
    // https://github.com form (the schema's scheme refine constrains values).
    const links = page.getByRole('link', { name: 'View on GitHub' });
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute(
      'href',
      'https://github.com/e2e-fixtures/tradr-changelog/releases/tag/v0.2.0',
    );
    await expect(links.nth(1)).toHaveAttribute(
      'href',
      'https://github.com/e2e-fixtures/tradr-changelog/releases/tag/v0.1.0',
    );
    await expect(links.nth(0)).toHaveAttribute('target', '_blank');
  });

  test('fresh user sees the Changelog nav link with no badge; absence holds after visiting', async ({
    page,
  }) => {
    // Every fixture release predates this registration, so the account-creation
    // floor guarantees badge absence — deterministic regardless of when the
    // suite warmed the process-local cache (REQ-5(a)).
    await registerUser(page.request, 'badge');

    await gotoAndAwaitReleases(page, '/dashboard');
    const changelogLink = page.getByRole('link', { name: 'Changelog' });
    await expect(changelogLink).toBeVisible();
    await expect(changelogLink).toHaveAttribute('href', '/changelog');
    // No badge: the indicator's accessible name is absent (REQ-5(a)(5) shape —
    // the sr-only text is the badge's pinned accessible name).
    await expect(page.getByText('New updates available')).toHaveCount(0);

    // Follow the link — the page renders the releases.
    await changelogLink.click();
    await expect(page).toHaveURL(/\/changelog$/);
    await expect(page.locator('[data-slot="card"]')).toHaveCount(2);

    // Badge stays absent after a full reload (floor only ever moves forward).
    await gotoAndAwaitReleases(page, '/dashboard');
    await expect(page.getByRole('link', { name: 'Changelog' })).toBeVisible();
    await expect(page.getByText('New updates available')).toHaveCount(0);
  });

  test('still renders releases after the upstream goes down (cache resilience)', async ({
    page,
  }) => {
    await registerUser(page.request, 'resilience');

    // First view in `ok` mode — renders releases and guarantees the API's
    // process-local cache is warm even if this test runs in isolation.
    await page.goto('/changelog');
    await expect(page.locator('[data-slot="card"]')).toHaveCount(2);

    try {
      // Kill the upstream, then reload: the page must still render releases —
      // served from the cache, no upstream dependency at page-view time
      // (REQ-2.4 / §18 resilience).
      await setStubMode(page.request, 'fail');
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Changelog' })).toBeVisible();
      await expect(page.locator('[data-slot="card"]')).toHaveCount(2);
      await expect(page.getByText('v0.2.0 — Beta improvements')).toBeVisible();
      await expect(page.getByText('v0.1.0 — First release')).toBeVisible();
    } finally {
      // Leave the stub healthy for later suites (their sidebars query the
      // same API process) and for locally reused stub processes.
      await setStubMode(page.request, 'ok');
    }
  });
});

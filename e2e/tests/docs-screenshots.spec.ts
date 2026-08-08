import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Documentation screenshot capture.
 *
 * Regenerates every image the user-guide "Getting started" page shows, from a
 * booted stack and the sample-data fixture, in both themes. The images are the
 * output of this file rather than the input: nothing here asserts against a
 * committed baseline, so this is a generator, not a pixel-diff gate.
 *
 * ── Not a CI gate ──────────────────────────────────────────────────────────
 *
 * The whole describe is guarded behind `DOCS_SCREENSHOT_CAPTURE`. With the flag
 * UNSET — the normal `pnpm --filter @tradr/e2e test` run the CI e2e job
 * executes — every case skips, so the job pays nothing for it. To regenerate,
 * run the full stack and:
 *
 *   DOCS_SCREENSHOT_CAPTURE=1 CI=1 \
 *     pnpm --filter @tradr/e2e exec playwright test \
 *     docs-screenshots.spec.ts --project=chromium
 *
 * `CI=1` pins the chromium rendering to what a CI re-run would produce, so two
 * regenerations of the same commit are comparable. There is no
 * `--update-snapshots` here because there are no snapshots — the images are
 * written straight into `apps/docs/src/assets/screenshots/`, and the resulting
 * working-tree change is what gets reviewed.
 *
 * ── Why the figures are quotable ───────────────────────────────────────────
 *
 * The sample-data seeder writes a fixed table of fourteen trades with literal
 * prices and absolute dates, so the numbers in these images are the same on
 * every run and a docs author can quote them in prose. The reads below assert
 * those figures rather than trusting them, so a fixture that drifts fails here
 * instead of silently changing every image.
 *
 * ── Why a failed run leaves no image behind ────────────────────────────────
 *
 * Every PNG in the output directory is deleted before the first capture, and
 * the run ends by checking that exactly the manifest's files came back, each
 * one non-empty and written during this run. A surface that cannot be reached
 * therefore fails loudly at its own readiness check and leaves a hole a reader
 * can see, rather than leaving last month's image in place to be shipped as if
 * it were current.
 *
 * STACK REQUIREMENT: the dev stack (web + api + stubs + db) must be running —
 * Playwright boots web/api/stubs via playwright.config.ts; Postgres must be
 * reachable at DATABASE_URL.
 */

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const OUTPUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../apps/docs/src/assets/screenshots',
);

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/**
 * THE MANIFEST — one entry per surface the getting-started guide walks a reader
 * through, in the order the guide meets them. It is the contract the final
 * check reads: a surface listed here but never captured fails the run, and a
 * file in the output directory that no entry names fails it too, which is what
 * keeps a renamed surface from leaving its predecessor behind.
 */
const SURFACES = [
  // Step 1 — create your account.
  'sign-up',
  'dashboard-first-login',
  // Step 2 — add a brokerage account.
  'new-account-dialog',
  'accounts-list',
  // Step 3 — log a trade through its lifecycle.
  'positions-list',
  'position-detail',
  // Step 4 — see it on the dashboard.
  'dashboard',
  // Step 5 — ask the advisor.
  'advisor',
  // Step 6 — review performance.
  'performance',
] as const;
type Surface = (typeof SURFACES)[number];

/** A PNG under 4 KB is a blank or half-painted frame, not a screenshot. */
const MIN_IMAGE_BYTES = 4096;

const imagePath = (surface: Surface, theme: Theme): string =>
  path.join(OUTPUT_DIR, `${surface}-${theme}.png`);

/** Milliseconds at which the capture began — every image must post-date it. */
let runStartedAt = 0;

/**
 * Empty the output directory of images before anything is written. This is the
 * half of the no-stale-image guarantee that a mid-run failure cannot undo: once
 * the old files are gone, a run that dies on surface five cannot leave surfaces
 * six onwards looking current.
 */
function clearOutputDir(): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const entry of fs.readdirSync(OUTPUT_DIR)) {
    if (entry.endsWith('.png')) fs.unlinkSync(path.join(OUTPUT_DIR, entry));
  }
  runStartedAt = Date.now();
}

/**
 * Write one image and prove it landed.
 *
 * Two checks run first, because both failures produce a file that looks fine to
 * the capture and wrong to a reader:
 *
 *  - A skeleton still on screen means a lazily-loaded panel has not painted.
 *    The first run of this spec caught the dashboard mid-load and drew the
 *    equity curve — the figure the guide's step 4 is about — as a grey box.
 *  - Horizontal overflow puts the page's own width above the viewport's, and a
 *    full-page capture then paints the side drawer's parked off-canvas panel
 *    inside the frame, as if a user had opened it.
 *
 * `page.screenshot` resolving is not the same claim as a usable file existing,
 * so the size and mtime are read back afterwards — the point in the run closest
 * to the write, where the failure still names the surface that caused it.
 */
async function shoot(page: Page, surface: Surface, theme: Theme): Promise<void> {
  await expect(
    page.locator('[data-slot="skeleton"]'),
    `${surface} (${theme}) finished loading before capture`,
  ).toHaveCount(0);
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow, `${surface} (${theme}) fits the capture viewport`).toBeLessThanOrEqual(0);

  const file = imagePath(surface, theme);
  await page.screenshot({
    path: file,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  expect(fs.existsSync(file), `${surface} (${theme}) wrote an image`).toBe(true);
  const stat = fs.statSync(file);
  expect(stat.size, `${surface} (${theme}) image is not a blank frame`).toBeGreaterThan(
    MIN_IMAGE_BYTES,
  );
  expect(stat.mtimeMs, `${surface} (${theme}) image is from this run`).toBeGreaterThanOrEqual(
    runStartedAt,
  );
}

/**
 * The last word on whether the run produced a publishable set. Set equality in
 * both directions: a missing image is a surface that never got captured, and an
 * unexpected one is a leftover the docs could still be pointing at.
 */
function verifyManifest(): void {
  const expected = SURFACES.flatMap((surface) =>
    THEMES.map((theme) => `${surface}-${theme}.png`),
  ).sort();
  const actual = fs
    .readdirSync(OUTPUT_DIR)
    .filter((entry) => entry.endsWith('.png'))
    .sort();
  expect(actual, 'every documented surface has an image in both themes, and nothing else').toEqual(
    expected,
  );
}

// ---------------------------------------------------------------------------
// Stack helpers — the idioms the rest of this directory uses
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

function uniqueEmail(): string {
  return `e2e-docs-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login. `/register` is rate-limited per
 * client IP and the harness trusts the loopback proxy, so a forwarded IP is
 * what the limiter keys off. The third octet is this spec's own — 132; every
 * other suite has taken 112-124 and 130/131, and sharing one would put these
 * registrations in another suite's bucket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.132.${ipCounter % 254}`;
}

async function registerUser(req: APIRequestContext): Promise<string> {
  const email = uniqueEmail();
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
}

async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Drive the theme from the sidebar control a user would use, then wait for the
 * class the whole stylesheet keys off before returning, so no capture races the
 * repaint. The preference is stored per browser, so one call holds for the rest
 * of the pass; `assertTheme` below is what proves that rather than assumes it.
 */
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.getByRole('menuitemradio', { name: theme === 'dark' ? 'Dark' : 'Light' }).click();
  await assertTheme(page, theme);
  // Let the theme transition settle before anything is captured.
  await page.waitForTimeout(200);
}

async function assertTheme(page: Page, theme: Theme): Promise<void> {
  if (theme === 'dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  }
}

test.describe('documentation screenshots', () => {
  test.skip(
    // eslint-disable-next-line no-restricted-syntax -- e2e harness flag; no @/lib/config here
    () => !process.env.DOCS_SCREENSHOT_CAPTURE,
    'On-demand docs capture — set DOCS_SCREENSHOT_CAPTURE=1 to run. Not a CI gate.',
  );
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop chromium only — the guide documents the desktop chrome.',
  );

  test('capture every documented surface in light and dark', async ({ page, request }) => {
    // One booted stack, one user, eighteen full-page images — far past the
    // default per-test budget, and a generator rather than a gate.
    test.setTimeout(600_000);
    // Wider than the project's default desktop viewport. The positions table is
    // the widest surface the guide shows and it needs about 1390px; below that
    // the page scrolls sideways, which both crops the table and drags the side
    // drawer's parked panel into a full-page frame.
    await page.setViewportSize({ width: 1440, height: 900 });
    clearOutputDir();

    const email = await registerUser(request);

    // --- Step 1: the sign-up form, before there is a session ----------------
    // Reached from the login page's own link, which is the path the guide
    // describes and the only one that works: a cold load of /register runs the
    // me-query as an anonymous visitor, and the first 401 of a document sends
    // the app to /login.
    //
    // Logged out there is no sidebar and so no theme control, so the preference
    // is written where next-themes keeps it — `localStorage`, per origin rather
    // than per session — and picked up on the next document load. That is the
    // same mechanism the toggle uses, so it captures a real theme rather than a
    // class forced onto <html>.
    await page.goto('/login');
    for (const theme of THEMES) {
      await page.evaluate((value) => window.localStorage.setItem('theme', value), theme);
      await page.goto('/login');
      const signUpLink = page.getByRole('link', { name: 'Register' });
      await expect(signUpLink).toBeVisible();
      await signUpLink.click();
      await expect(page.getByLabel('Confirm password')).toBeVisible();
      await assertTheme(page, theme);
      await shoot(page, 'sign-up', theme);
    }

    await loginViaUi(page, email);

    // --- Steps 1-2, before any account exists -------------------------------
    // What a reader actually meets on first login, and the dialog the guide's
    // "New account" step describes. Both only exist while the user has no
    // accounts, so they are captured before the sample data is seeded.
    for (const theme of THEMES) {
      await page.goto('/dashboard');
      await expect(page.getByTestId('onboarding-zero-state')).toBeVisible();
      await expect(page.getByTestId('activation-checklist')).toBeVisible();
      await setTheme(page, theme);
      await shoot(page, 'dashboard-first-login', theme);

      // The theme control lives behind the dialog's overlay once it is open, so
      // the theme is settled first and the dialog opened second.
      await page.getByTestId('zero-state-create-account').click();
      await expect(page.getByLabel('Name')).toBeVisible();
      await shoot(page, 'new-account-dialog', theme);
      await page.keyboard.press('Escape');
      await expect(page.getByLabel('Name')).toHaveCount(0);
    }

    // --- Seed the sample data ----------------------------------------------
    // Every figure from here on comes from the fixed fourteen-trade fixture, so
    // the images and the prose can quote the same numbers.
    const seeded = await page.request.post('/api/accounts/demo');
    expect(seeded.status(), 'POST /accounts/demo').toBe(201);

    const positions = (await (await page.request.get('/api/positions')).json()) as {
      id: string;
      symbol: string;
      status: string;
    }[];
    expect(positions, 'the fixture is the fourteen-trade set the docs quote').toHaveLength(14);
    const closed = positions.filter((position) => position.status === 'closed');
    expect(closed, 'the fixture has ten closed trades').toHaveLength(10);
    // The guide's worked example is a closed long, so the detail shot is one.
    const detail = closed.find((position) => position.symbol === 'AAPL');
    expect(detail, 'the fixture still contains the closed AAPL trade').toBeDefined();

    // --- Steps 2-6, against the sample data ---------------------------------
    for (const theme of THEMES) {
      await page.goto('/dashboard');
      await expect(page.locator('[data-widget-type]').first()).toBeVisible();
      await setTheme(page, theme);

      await page.goto('/accounts');
      await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
      await expect(page.getByTestId('demo-banner')).toBeVisible();
      await assertTheme(page, theme);
      await shoot(page, 'accounts-list', theme);

      await page.goto('/positions');
      await expect(page.getByRole('heading', { name: 'Positions' })).toBeVisible();
      await expect(page.locator('table tbody tr')).toHaveCount(14);
      await shoot(page, 'positions-list', theme);

      await page.goto(`/positions/${detail!.id}`);
      await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
      await shoot(page, 'position-detail', theme);

      await page.goto('/dashboard');
      await expect(page.locator('[data-widget-type]').first()).toBeVisible();
      await shoot(page, 'dashboard', theme);

      await page.goto('/advisor');
      await expect(page.getByTestId('conversation-pane')).toBeVisible();
      await shoot(page, 'advisor', theme);

      // Explicit dates rather than the sidebar link's rolling default: the link
      // anchors its window on today, which would move the chart under every
      // regeneration. This window brackets the fixture's own span.
      await page.goto('/performance?granularity=month&start=2026-02-01&end=2026-08-01&tz=UTC');
      await expect(page.getByTestId('performance-page')).toBeVisible();
      await shoot(page, 'performance', theme);
    }

    verifyManifest();
  });
});

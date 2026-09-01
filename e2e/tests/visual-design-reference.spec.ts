import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { promoteToAdmin } from '../support/db';

/**
 * Pre-migration structural reference capture — visual-design Task 1 (REQ-12.5).
 *
 * A ONE-SHOT, manually-run reference of the affected surfaces in BOTH themes,
 * captured BEFORE the index.css/token substrate (Task 2) lands. The committed
 * images under `visual-design-reference.spec.ts-snapshots/` are a *reference
 * artifact* a reviewer diffs before↔after during the migration — NOT a
 * CI-failing pixel-diff gate. The re-skin intentionally changes color, type,
 * spacing and the money-direction encoding, so a pixel diff would flood with
 * expected changes and defeat the purpose; this reference exists only to catch
 * *unintended structural* regressions (a column collapsing, a figure
 * truncating, a widget reflowing) that the data-level suite cannot see.
 *
 * ── Why this is NOT a CI gate ──────────────────────────────────────────────
 *
 * The whole describe is guarded behind `VISUAL_REFERENCE_CAPTURE=1`. With the
 * flag UNSET (the normal `pnpm --filter @tradr/e2e test` run the CI e2e job
 * executes) every case is `test.skip`'d, so the e2e job stays green and this
 * spec never gates a build. To (re)capture the reference, run the full stack
 * and:
 *
 *   VISUAL_REFERENCE_CAPTURE=1 CI=1 \
 *     pnpm --filter @tradr/e2e exec playwright test \
 *     visual-design-reference.spec.ts --project=chromium --update-snapshots
 *
 * `CI=1` pins the chromium rendering Playwright uses in CI so the committed
 * reference matches what a CI re-run would produce; `--update-snapshots` writes
 * the committed reference images.
 *
 * STACK REQUIREMENT: dev stack (web + api + UW stub + db) must be running —
 * Playwright boots web/api/stub via playwright.config.ts; Postgres must be
 * reachable at DATABASE_URL.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-visual-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register call — the `/register` route is
 * rate-limited per client IP; the harness trusts `127.0.0.1` as a proxy
 * (playwright.config.ts) so the limiter keys off this forwarded IP. A distinct
 * 3rd octet (.130) keeps this spec's limiter bucket separate from the others'.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.130.${ipCounter % 254}`;
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

/**
 * Set the app theme via the sidebar toggle (dashboard.spec.ts:325-335 pattern):
 * open the "Toggle theme" menu, pick Light or Dark, then assert the `.dark`
 * class on <html> matches before returning so the screenshot is taken in a
 * settled theme.
 */
async function setTheme(page: Page, theme: 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.getByRole('menuitemradio', { name: theme }).click();
  if (theme === 'Dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  }
  // Let the reduced-motion-free theme transition settle before capture.
  await page.waitForTimeout(200);
}

/**
 * Capture a full-page reference of the current surface in both themes. The
 * image name is stable per (surface, theme) so re-runs overwrite the same
 * committed reference. `animations:'disabled'` + `caret:'hide'` keep the shot
 * deterministic; this is a reference write, not an assertion.
 */
async function captureBothThemes(page: Page, surface: string): Promise<void> {
  await setTheme(page, 'Light');
  await expect(page).toHaveScreenshot(`${surface}-light.png`, {
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  await setTheme(page, 'Dark');
  await expect(page).toHaveScreenshot(`${surface}-dark.png`, {
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
}

// ===========================================================================
// One-shot reference capture (chromium only). Guarded behind the
// VISUAL_REFERENCE_CAPTURE flag so the normal suite — and the CI e2e gate —
// skip it entirely (the e2e job stays green; this is a manual capture).
// ===========================================================================

test.describe('visual-design pre-migration reference', () => {
  test.skip(
    // eslint-disable-next-line no-restricted-syntax -- e2e harness flag; no @/lib/config here
    () => !process.env.VISUAL_REFERENCE_CAPTURE,
    'One-shot reference capture — set VISUAL_REFERENCE_CAPTURE=1 to run. Not a CI gate.',
  );
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop chromium only — the reference is the desktop chrome.',
  );

  // All surfaces share one seeded admin user (admin needs the DB promotion
  // seam — admin-platform.spec.ts pattern) with one open position so the
  // positions list + detail render real figures.
  let user: SeededUser;
  let positionId: string;

  test.beforeAll(async ({ request }) => {
    user = await registerUser(request, 'ref');
    await promoteToAdmin(user.email);
  });

  test('capture all surfaces in light + dark', async ({ page }) => {
    // One test captures ~24 full-page screenshots over a booted stack — well
    // past the default 30s per-test timeout. This is a one-shot capture, not a
    // gated assertion, so a generous budget is fine.
    test.setTimeout(300_000);
    await loginViaUi(page, user.email);

    // --- Seed one account + one open position (drawer + positions surfaces) ---
    const accountRes = await page.request.post('/api/accounts', {
      data: { name: 'USD Account', currency: 'USD' },
    });
    expect(accountRes.status(), 'POST /accounts').toBe(201);
    const account = (await accountRes.json()) as { id: string };
    // An established user, not an onboarding one: the dashboard keeps its
    // focused welcome view until onboarding is done or skipped, and the
    // dashboard captures here are of the populated grid.
    const onboardingRes = await page.request.patch('/api/users/me/onboarding', {
      data: { status: 'done' },
    });
    expect(onboardingRes.status(), 'PATCH onboarding').toBe(200);

    const posRes = await page.request.post('/api/positions', {
      data: { accountId: account.id, symbol: 'AAPL', side: 'long', assetType: 'stock' },
    });
    expect(posRes.status(), 'POST /positions').toBe(201);
    positionId = ((await posRes.json()) as { id: string }).id;

    const fillRes = await page.request.post(`/api/positions/${positionId}/fills`, {
      data: {
        type: 'entry',
        price: '150.00',
        quantity: '10',
        fees: '1.00',
        filledAt: '2026-05-01T14:30:00.000Z',
      },
    });
    expect(fillRes.status(), 'POST entry fill').toBe(201);
    const openRes = await page.request.post(`/api/positions/${positionId}/open`, { data: {} });
    expect(openRes.status(), 'POST /positions/:id/open').toBe(200);

    // --- dashboard ---
    await page.goto('/dashboard');
    await expect(page.locator('section[data-widget-id]').first()).toBeVisible();
    await captureBothThemes(page, 'dashboard');

    // --- positions list ---
    await page.goto('/positions');
    await expect(page.getByRole('heading', { name: 'Positions' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'AAPL' }).first()).toBeVisible();
    await captureBothThemes(page, 'positions-list');

    // --- positions detail ---
    await page.goto(`/positions/${positionId}`);
    await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
    await captureBothThemes(page, 'positions-detail');

    // --- side drawer (opened over the dashboard) ---
    await page.goto('/dashboard');
    await expect(page.locator('section[data-widget-id]').first()).toBeVisible();
    await page.getByRole('button', { name: /open side drawer/i }).click();
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
    await captureBothThemes(page, 'drawer');

    // --- accounting (expenses) ---
    await page.goto('/accounting/expenses');
    await expect(page).toHaveURL(/\/accounting\/expenses/);
    await captureBothThemes(page, 'accounting-expenses');

    // --- accounting (tax summary) ---
    await page.goto('/accounting/tax-summary');
    await expect(page).toHaveURL(/\/accounting\/tax-summary/);
    await captureBothThemes(page, 'accounting-tax-summary');

    // --- accounting (fee rollup) ---
    await page.goto('/accounting/fee-rollup');
    await expect(page).toHaveURL(/\/accounting\/fee-rollup/);
    await captureBothThemes(page, 'accounting-fee-rollup');

    // --- advisor ---
    await page.goto('/advisor');
    await expect(page).toHaveURL(/\/advisor/);
    await captureBothThemes(page, 'advisor');

    // --- billing ---
    await page.goto('/settings/billing');
    await expect(page).toHaveURL(/\/settings\/billing/);
    await captureBothThemes(page, 'billing');

    // --- admin (user was promoted in beforeAll) ---
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin$/);
    await captureBothThemes(page, 'admin');

    // --- settings (profile tab) ---
    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/settings\/profile/);
    await captureBothThemes(page, 'settings');

    // --- auth (login) — logged-out surface; capture last so the session can
    //     be dropped. The theme cookie persists across logout so both themes
    //     still apply on the public /login route. ---
    await page.request.post('/api/auth/logout').catch(() => undefined);
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    // /login has no in-app sidebar theme toggle; drive `.dark` directly on the
    // root so the auth surface is still captured in both themes.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await expect(page).toHaveScreenshot('auth-login-light.png', {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page).toHaveScreenshot('auth-login-dark.png', {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });
});

import crypto from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { totpAt, totpNow } from '../support/totp';

/**
 * two-factor e2e suite (security-hardening Task 21).
 *
 * Per design.md §Testing Strategy > End-to-end, against the booted self-host
 * stack (the same Playwright `webServer` boot the other live suites use — see
 * e2e/playwright.config.ts, no Stripe and no object bucket configured):
 *
 *   TOTP helper — the `node:crypto` generator in e2e/support/totp.ts reproduces
 *                 the RFC 6238 Appendix B SHA-1 vector at T=59s. This is a pure
 *                 check with no stack dependency, so it runs first and ungated.
 *
 *   sign-in     — register a user through the API, then drive the real UI: enrol
 *                 in two-factor on the Account settings tab by reading the text
 *                 key and confirming with a generated code, keep the 10 backup
 *                 codes shown once; log out and sign in with password + a TOTP
 *                 code to land on /dashboard; sign in again with one backup code,
 *                 then see that same code refused on a later sign-in; finally
 *                 submit wrong codes and passwords until the address is locked
 *                 and the login page shows the retry message.
 *
 * ── Driving the app, not injecting behaviour ───────────────────────────────
 *
 * The user is registered through the API (the account-data / account-deletion
 * pattern) because registration is not the surface under test; the authenticator
 * is played by the TOTP helper, exactly as a real second device would. Every
 * sign-in, enrolment and lockout goes through the app's own UI and HTTP API — no
 * behaviour is stubbed or injected from the test.
 *
 * RFC 6238 Appendix B shares the ASCII secret "12345678901234567890"; its RFC
 * 4648 base32 (no padding) is below.
 */

const PASSWORD = 'test-password-1234';
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function uniqueEmail(label: string): string {
  // crypto.randomUUID() — a unique value without Math.random() (CodeQL).
  return `e2e-2fa-${label}-${crypto.randomUUID()}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login call. `/login` and `/register`
 * are rate-limited per client IP; the harness trusts the loopback proxy
 * (`TRUSTED_PROXIES=127.0.0.1`, playwright.config.ts), so the limiter keys off
 * this forwarded IP and a fresh one never trips it — while the per-address
 * lockout counts failures regardless of IP (design C3). The third octet — 144 —
 * is this spec's own; every other suite's range is taken. `process.pid`
 * namespaces each Playwright worker.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.144.${ipCounter % 254}`;
}

/** Register a user through the API — registration is not the surface under test. */
async function registerUser(req: APIRequestContext, label: string): Promise<string> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
}

/** Password-only sign-in through the form (two-factor not yet enabled). */
async function loginPasswordOnly(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** The first login step for a two-factor account: password → the code field. */
async function loginToCodeStep(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByLabel('Authentication code')).toBeVisible();
}

/** Submit a code at the second sign-in step. */
async function submitLoginCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Authentication code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
}

/** Sign out through the real control on the Account settings tab. */
async function logout(page: Page): Promise<void> {
  await page.goto('/settings/account');
  // The settings tab's own "Log out" button, not the sidebar's icon button.
  await page
    .locator('[data-slot="settings-account"]')
    .getByRole('button', { name: 'Log out' })
    .click();
  await expect(page).toHaveURL(/\/login/);
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

// ── The TOTP helper check (pure, ungated) ────────────────────────────────────
//
// RFC 6238 Appendix B, SHA-1, T=59s → counter step floor(59/30) = 1 → the
// 8-digit value 94287082, whose last six digits are "287082". The helper the
// browser flow uses to play the authenticator must reproduce exactly this.
test('TOTP helper reproduces the RFC 6238 Appendix B vector at T=59', () => {
  expect(totpAt(RFC_SECRET_BASE32, Math.floor(59 / 30))).toBe('287082');
  // The time-based wrapper agrees when the clock reads T=59s (59_000 ms).
  expect(totpNow(RFC_SECRET_BASE32, 0, 59_000)).toBe('287082');
});

test.describe('two-factor sign-in', () => {
  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('enrol, code sign-in, backup code, lock', async ({ page, request }) => {
    // Many sign-ins, each a page navigation and a form round trip, plus the
    // lockout accumulation — allow well beyond the default expect timeout.
    test.setTimeout(120_000);

    const email = await registerUser(request, 'user');

    // ── Enrol in two-factor on the Account settings tab ───────────────────────
    await loginPasswordOnly(page, email);
    await page.goto('/settings/account');

    // The status badge only renders once the status query resolves, so waiting
    // for "Off" confirms the two-factor section has loaded.
    await expect(page.getByTestId('two-factor-status')).toHaveText('Off');

    await page.getByRole('button', { name: 'Set up two-factor' }).click();

    const enrol = page.getByTestId('two-factor-enrol');
    await expect(enrol).toBeVisible();
    // The text key (base32 secret) shown beside the QR code.
    const secret = ((await enrol.locator('p.font-mono').textContent()) ?? '').trim();
    expect(secret, 'enrolment shows the base32 text key').toMatch(/^[A-Z2-7]+$/);

    // Confirm with a code generated for the current step, exactly as an app would.
    await page.locator('#two-factor-enrol-code').fill(totpNow(secret, 0));
    await page.getByRole('button', { name: 'Confirm' }).click();

    // The 10 single-use backup codes, shown once.
    const codesView = page.getByTestId('two-factor-backup-codes');
    await expect(codesView).toBeVisible();
    const backupCodes = (await codesView.locator('li').allInnerTexts()).map((c) => c.trim());
    expect(backupCodes, 'ten backup codes shown').toHaveLength(10);
    for (const code of backupCodes) {
      expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    }

    await logout(page);

    // ── Sign in with a TOTP code → /dashboard ─────────────────────────────────
    // One step ahead of the confirm step so the server's replay guard (a step
    // must exceed the last used one) accepts it.
    await loginToCodeStep(page, email);
    await submitLoginCode(page, totpNow(secret, 1));
    await expect(page).toHaveURL(/\/dashboard/);
    await logout(page);

    // ── Sign in with one backup code → /dashboard ─────────────────────────────
    const usedBackupCode = backupCodes[0];
    await loginToCodeStep(page, email);
    await submitLoginCode(page, usedBackupCode);
    await expect(page).toHaveURL(/\/dashboard/);
    await logout(page);

    // ── The same backup code is refused on a later sign-in ────────────────────
    await loginToCodeStep(page, email);
    await submitLoginCode(page, usedBackupCode);
    await expect(page.getByText(/That code is not valid/)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // ── Wrong codes and passwords until the address is locked ─────────────────
    // Driven against the app's own endpoints with a fresh forwarded IP each
    // time, so the per-IP limiter never trips while the per-address lock counts
    // every failure. "wrongcode" is a valid-length code (6-20) that is neither a
    // 6-digit TOTP nor any issued backup code, so it always fails.
    for (let i = 0; i < 2; i++) {
      const start = await request.post('/api/auth/login', {
        data: { email, password: PASSWORD },
        headers: { 'X-Forwarded-For': uniqueIp() },
        failOnStatusCode: false,
      });
      expect(start.status(), 'correct password returns a challenge').toBe(202);
      const { challenge } = (await start.json()) as { challenge: string };
      const wrong = await request.post('/api/auth/login/two-factor', {
        data: { challenge, code: 'wrongcode' },
        headers: { 'X-Forwarded-For': uniqueIp() },
        failOnStatusCode: false,
      });
      expect(wrong.status(), 'a wrong code is refused').toBe(400);
    }

    let locked = false;
    for (let i = 0; i < 14 && !locked; i++) {
      const res = await request.post('/api/auth/login', {
        data: { email, password: 'the-wrong-password' },
        headers: { 'X-Forwarded-For': uniqueIp() },
        failOnStatusCode: false,
      });
      if (res.status() === 429) locked = true;
      else expect(res.status(), 'a pre-lock failure is a 401').toBe(401);
    }
    expect(locked, 'the address locks after repeated failures').toBe(true);

    // The login page surfaces the lock with the server's retry message.
    await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByText(/Too many failed sign-ins/)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});

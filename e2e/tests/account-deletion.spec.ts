import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { promoteToAdmin } from '../support/db';

/**
 * account-deletion e2e suite (Task 19).
 *
 * Per design.md §Testing Strategy > End-to-end, against the booted self-host
 * stack (the same Playwright `webServer` boot the other live suites use — see
 * e2e/playwright.config.ts, no Stripe and no object bucket configured):
 *
 *   self-service — register a user, seed a position, open the Account tab's
 *                  delete dialog and check the retention lines + docs link; a
 *                  wrong password errors and stays signed in; the right one
 *                  lands on `/login` with the deleted notice. Then the old
 *                  session cookie 401s on `GET /api/auth/me`, the old login
 *                  fails, and the email registers again.
 *   admin        — promote a second user and delete a third from the admin
 *                  user table; the row disappears and the target 404s.
 *
 * The scheduled (paid-tier) path and the object-bucket purge are integration
 * only — this suite runs with nothing gated configured, so every deletion here
 * fires immediately (design §Testing Strategy, Scope notes).
 *
 * ── Seeding (the e2e DB seam) ──────────────────────────────────────────────
 *
 * Users are registered through the API (the admin-platform / wallet-billing
 * pattern); the admin is minted with support/db.ts `promoteToAdmin` — the
 * documented bootstrap `UPDATE users SET is_admin = true`, read per-request by
 * the auth middleware, so no re-login is needed. Every navigation is by URL
 * (`page.goto`) rather than the sidebar, so the flows are viewport-independent
 * and run under both projects (chromium + the iPhone-13 webkit project).
 */

const PASSWORD = 'test-password-1234';
const OPENED_AT = '2026-05-01T14:30:00.000Z';

// docsUrl('accountDeletion') — apps/web/src/lib/docs.ts. The dialog's docs link
// must point at the retention statement page.
const ACCOUNT_DELETION_DOCS_URL = 'https://docs.tradr.cloud/user-guide/account-deletion/';

function uniqueEmail(label: string): string {
  return `e2e-acct-del-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login call. `/register` is rate-limited
 * to 5 / 15 min per client IP; the harness trusts the loopback proxy
 * (`TRUSTED_PROXIES=127.0.0.1`, playwright.config.ts), so the limiter keys off
 * this forwarded IP. The third octet — 141 — is this spec's own; every other
 * suite's range is taken. `process.pid` namespaces each Playwright worker so the
 * chromium and webkit projects never replay the same low IPs.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.141.${ipCounter % 254}`;
}

interface SeededUser {
  email: string;
  userId: string;
}

/**
 * Register a user; the session cookie lands on `req`, so the returned context
 * stays authenticated as this user for API-side setup and later assertions.
 */
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

/** A funded account over the API — account creation is not the surface under test. */
async function createAccount(req: APIRequestContext, name: string): Promise<string> {
  const res = await req.post('/api/accounts', {
    data: { name, currency: 'USD', startingBalance: '10000' },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `POST /accounts ${name}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A position the user has open with one entry fill — the account has real data
 * for the cascade to remove. The entry fill MUST precede `/open`: the API
 * refuses to open a position that has none.
 */
async function createOpenPosition(req: APIRequestContext, accountId: string): Promise<string> {
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' },
  });
  expect(posRes.status(), 'POST /positions').toBe(201);
  const positionId = ((await posRes.json()) as { id: string }).id;

  const entryRes = await req.post(`/api/positions/${positionId}/fills`, {
    data: { type: 'entry', price: '150.00', quantity: '10', fees: '0', filledAt: OPENED_AT },
  });
  expect(entryRes.status(), 'POST entry fill').toBe(201);

  const openRes = await req.post(`/api/positions/${positionId}/open`, {
    data: { openedAt: OPENED_AT },
  });
  expect(openRes.status(), 'POST /open').toBe(200);
  return positionId;
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

test.describe('account-deletion', () => {
  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('self-service delete: dialog, wrong then right password, and the aftermath', async ({
    page,
    request,
  }) => {
    // Register + seed on the `request` context: it keeps its OWN session cookie,
    // which the cascade must later invalidate (the "old cookie 401s" assertion).
    const user = await registerUser(request, 'self');
    const accountId = await createAccount(request, 'Deletion account');
    await createOpenPosition(request, accountId);

    // A separate browser session for the same user drives the UI.
    await loginViaUi(page, user.email);

    // ── The delete dialog ──────────────────────────────────────────────────
    await page.goto('/settings/account');
    const deleteButton = page.getByRole('button', { name: 'Delete account' });
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    const dialog = page.getByTestId('delete-account-dialog');
    await expect(dialog).toBeVisible();

    // Retention lines (RetentionSummary, task 16) and the docs link.
    const retention = dialog.getByTestId('retention-summary');
    await expect(retention.getByText('What deletion keeps')).toBeVisible();
    await expect(
      retention.getByText('Stripe keeps its customer and invoice records.'),
    ).toBeVisible();
    await expect(
      retention.getByText(
        'One tombstone row stays, so the account cannot be deleted a second time.',
      ),
    ).toBeVisible();
    await expect(retention.getByText('Your money')).toBeVisible();
    await expect(retention.getByTestId('retention-credits')).toContainText('not refunded');
    await expect(
      retention.getByRole('link', { name: 'What deletion removes and what it keeps' }),
    ).toHaveAttribute('href', ACCOUNT_DELETION_DOCS_URL);

    const passwordInput = dialog.getByLabel('Confirm your password');

    // ── Wrong password: inline error, still signed in, dialog stays open ─────
    await passwordInput.fill('wrong-password-9999');
    await dialog.getByRole('button', { name: 'Delete my account' }).click();
    await expect(dialog.getByTestId('delete-account-error')).toHaveText(
      'That password is incorrect.',
    );
    await expect(page).toHaveURL(/\/settings\/account/);
    await expect(dialog).toBeVisible();

    // ── Right password: land on /login with the deleted notice ───────────────
    await passwordInput.fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Delete my account' }).click();
    await expect(page).toHaveURL(/\/login\?deleted=true/);
    await expect(page.getByText('Your account was deleted.')).toBeVisible();

    // ── Aftermath (the `request` context still holds the pre-deletion cookie) ─
    // The old session cookie is now server-invalid.
    const meRes = await request.get('/api/auth/me', { failOnStatusCode: false });
    expect(meRes.status(), 'GET /api/auth/me with the deleted session').toBe(401);

    // The old login no longer works.
    const loginRes = await request.post('/api/auth/login', {
      data: { email: user.email, password: PASSWORD },
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(loginRes.status(), 'login as the deleted user').toBe(401);

    // The email is free to register again (the tombstone keeps only a hash).
    const reRegister = await request.post('/api/auth/register', {
      data: { email: user.email, password: PASSWORD },
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(reRegister.status(), 're-register the freed email').toBe(201);
  });

  test('an admin deletes a user from the admin table', async ({ page }) => {
    // Register the victim, then the admin LAST so the shared browser jar ends up
    // holding the admin's session (the admin-platform seam).
    const victim = await registerUser(page.request, 'victim');
    const admin = await registerUser(page.request, 'boss');
    await promoteToAdmin(admin.email);

    await page.goto('/admin');
    const users = page.getByRole('region', { name: 'Users' });
    const victimRow = users.getByRole('row').filter({ hasText: victim.email });
    await expect(victimRow).toBeVisible();

    // The row's Delete opens the typed-email confirm dialog (task 18).
    await victimRow.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByTestId('admin-delete-user-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: `Delete ${victim.email}` })).toBeVisible();

    await dialog.getByLabel(`Type ${victim.email} to confirm`).fill(victim.email);
    await dialog.getByRole('button', { name: 'Delete this account' }).click();

    // On success the dialog closes and the row drops out on the ['admin']
    // refetch — the durable outcomes (the "Deleted <email>." toast auto-dismisses
    // and is not a reliable gate). The immediate cascade delete does real server
    // work, so allow beyond the default expect timeout.
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await expect(victimRow).toHaveCount(0);

    // Server-side: the deleted user no longer resolves through the admin API.
    const detail = await page.request.get(`/api/admin/users/${victim.userId}`, {
      failOnStatusCode: false,
    });
    expect(detail.status(), 'GET admin detail for the deleted user').toBe(404);
  });
});

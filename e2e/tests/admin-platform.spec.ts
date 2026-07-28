import { expect, test, type APIRequestContext } from '@playwright/test';

import { promoteToAdmin } from '../support/db';

/**
 * admin-platform e2e suite (Task 23).
 *
 * Per design.md §Testing Strategy > End-to-End: against the booted stack
 * (the same Playwright `webServer` boot the other suites use — see
 * e2e/playwright.config.ts), seed an admin + a non-admin and assert:
 *
 *   admin     — sees the sidebar Admin link, loads /admin, the stats cards
 *               render (zero-tolerant: a fresh instance gets zero-value cards,
 *               never an error), and the user table lists both users;
 *   non-admin — sees NO Admin link, and direct navigation to /admin shows the
 *               not-authorized EmptyState (the backend 403 is the real
 *               boundary — this is the convenience surface over it).
 *
 * ── Admin seeding (the e2e DB seam) ────────────────────────────────────────
 *
 * Both users are registered via the API (the wallet-billing.spec.ts pattern),
 * then ONE is promoted via support/db.ts — the documented bootstrap statement
 * (`UPDATE users SET is_admin = true ...`) run with the same porsager
 * `postgres` driver and `DATABASE_URL` the booted API uses. `SEED_ADMIN_EMAIL`
 * cannot work here (the API boots before any user can register, and the
 * harness has no restart seam), and no API route can mint the first admin by
 * design. Promotion is read per-request by the auth middleware, so it takes
 * effect without re-login.
 *
 * ── Gating is deliberately NOT browser-driven ──────────────────────────────
 *
 * The capped-turn / insufficient-credits gating journey needs a deterministic
 * LLM provider, and the booted stack has no out-of-process LLM stub seam
 * (deferral d-a6b1ca41 precedent; see advisor-tools.spec.ts /
 * wallet-billing.spec.ts headers). Gating is covered at the integration layer
 * (admin-platform Task 16); the spec does not promise a browser-driven
 * capped-turn scenario, so nothing here is faked or fixme'd for it.
 *
 * The route-chunk guard (admin eager chunk excludes Recharts) is enforced by
 * the existing `totalBundle` CI gate — no browser assertion needed.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-admin-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register call. The auth `/register` route is
 * rate-limited to 5 / 15 min per client IP; the harness sets
 * `TRUSTED_PROXIES=127.0.0.1` (playwright.config.ts), so the limiter keys off
 * this forwarded IP rather than the shared loopback socket. Base differs from
 * the other suites' so parallel files never share a limiter bucket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // process.pid namespaces each Playwright worker process — the chromium +
  // Mobile Chrome projects re-run this spec in fresh workers that reset
  // ipCounter, so without it the low IPs replay and accumulate past the
  // /register limit (5 / 15 min). The distinct 3rd octet separates specs.
  return `10.${process.pid % 256}.112.${ipCounter % 254}`;
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

/**
 * Probe the stack — if the API is unreachable (no booted stack), skip
 * gracefully. Same guard as the other live suites.
 */
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

// ===========================================================================
// Desktop suite (chromium) — the sidebar Admin link and the admin tables are
// desktop-shaped. Mirror the wallet-billing / csv-import project gate.
// ===========================================================================

test.describe('admin-platform', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('admin sees the sidebar link, stats cards, and both users in the table', async ({
    page,
  }) => {
    // Register BOTH users through the shared cookie jar: the non-admin first,
    // then the admin — the jar ends up holding the admin's session.
    const nonAdmin = await registerUser(page.request, 'plain');
    const admin = await registerUser(page.request, 'boss');

    // Promote via the e2e DB seam (the documented bootstrap UPDATE). The auth
    // middleware reads is_admin per request, so the existing session is enough.
    await promoteToAdmin(admin.email);

    // Sidebar shows the Admin link (shield icon entry below Settings) for
    // admins (REQ-7.2).
    await page.goto('/dashboard');
    const adminLink = page.getByRole('link', { name: 'Admin' });
    await expect(adminLink).toBeVisible();
    await expect(adminLink).toHaveAttribute('href', '/admin');

    // Follow it to /admin (REQ-7.1).
    await adminLink.click();
    await expect(page).toHaveURL(/\/admin$/);

    // Stats cards render (REQ-1.x; zero-tolerant — a fresh instance shows
    // zero-value cards, so only presence + the pinned captions are asserted,
    // never non-zero values).
    const stats = page.getByRole('region', { name: 'Stats' });
    await expect(stats.getByText('Total users')).toBeVisible();
    await expect(stats.getByText(/Active now \(last \d+ min\)/)).toBeVisible();
    await expect(stats.getByText('Positions')).toBeVisible();
    await expect(stats.getByText('Revenue')).toBeVisible();
    await expect(stats.getByText('purchased-credit volume')).toBeVisible();

    // Total users is a real number and counts at least the two just-registered
    // accounts (the shared dev DB may hold more — assert a floor, not equality).
    const totalUsersText = await stats
      .getByText('Total users')
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
      .getByText(/^\d+$/)
      .innerText();
    expect(Number(totalUsersText)).toBeGreaterThanOrEqual(2);

    // User table lists both users, newest first — both rows are on the first
    // page since they were registered moments ago (REQ-3.1, REQ-7.3).
    const users = page.getByRole('region', { name: 'Users' });
    const adminRow = users.getByRole('row').filter({ hasText: admin.email });
    const nonAdminRow = users.getByRole('row').filter({ hasText: nonAdmin.email });
    await expect(adminRow).toBeVisible();
    await expect(nonAdminRow).toBeVisible();

    // The promoted user carries the Admin badge + a checked toggle; the plain
    // user does not.
    await expect(adminRow.getByText('Admin', { exact: true })).toBeVisible();
    await expect(adminRow.getByRole('switch')).toBeChecked();
    await expect(nonAdminRow.getByRole('switch')).not.toBeChecked();

    // The Usage section heading mounts too (chart internals are covered by
    // component tests; Recharts is lazy so only the section shell is asserted).
    await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
  });

  test('non-admin sees no Admin link; direct /admin navigation is not authorized', async ({
    page,
  }) => {
    await registerUser(page.request, 'nonadmin');

    // No Admin link in the sidebar — but the sidebar itself IS rendered
    // (Settings is there), so the absence assertion is not vacuous (REQ-7.2).
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);

    // Direct navigation renders the not-authorized EmptyState with the
    // back-to-dashboard escape hatch (REQ-7.5). The real boundary is the
    // backend 403 (ADMIN_REQUIRED) — proven by the API returning 403 below.
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Not authorized' })).toBeVisible();
    await expect(page.getByText('This page requires admin access.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );

    // And the admin API itself refuses this session — the UI state above is
    // convenience over a real 403, not the enforcement.
    const res = await page.request.get('/api/admin/stats', { failOnStatusCode: false });
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('ADMIN_REQUIRED');
  });
});

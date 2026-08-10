import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * transactional-email e2e suite (Task 17) — ENV-GUARDED round trips.
 *
 * Runs ONLY when BOTH hold, otherwise every test skips cleanly (CI and
 * Mailpit-less machines stay green — the vitest integration suite is the
 * merge gate):
 *
 *   1. the API was ARMED — playwright.config.ts forwards SMTP_HOST etc. into
 *      the booted API's env, so `SMTP_HOST` in THIS process's env means the
 *      API booted email-configured;
 *   2. the Mailpit REST API answers on :8025 (start it with
 *      `docker compose -f docker-compose.dev.yml up -d mailpit`).
 *
 * To arm a run, export the .env.example dev-Mailpit values first:
 *
 *   SMTP_HOST=localhost SMTP_PORT=1025 SMTP_TLS_MODE=none \
 *   EMAIL_FROM=dev@tradr.local pnpm --filter @tradr/e2e test
 *
 * (WEB_BASE_URL is defaulted to the Playwright web origin by the config's
 * arming conditional — the emailed links must land on THIS stack's pages.)
 *
 * Two journeys, each owning its whole flow through the real mailbox:
 *
 *   reset        — register (API) → /forgot-password → fetch the reset mail
 *                  via Mailpit REST (`GET /api/v1/messages`) → follow the
 *                  link → set a new password → old fails / new works
 *                  (REQ-4.6's e2e leg);
 *   verification — register via the UI FORM (this spec owns the only
 *                  UI-register flow in the suite) → check-your-email state
 *                  (Task 14) → fetch the verification mail → verify page →
 *                  gesture click (REQ-4.8) → settings shows Verified.
 *
 * Both journeys assert the emailed link carries the token in the URL
 * FRAGMENT (`#token=`, no query string) — a regression to query-string
 * carriage fails the spec (REQ-3.9).
 *
 * Existing suites are untouched by an armed run: they all register via
 * direct `POST /api/auth/register` helpers (201 + session cookie unchanged;
 * the additive `emailVerified: false` is asserted by nothing; the
 * post-commit dispatch is fire-and-forget into Mailpit).
 */

// Standalone Playwright CLI context — same `process.env` carve-out as
// playwright.config.ts (no `@/lib/config` in scope here).
/* eslint-disable no-restricted-syntax */
const baseURL = process.env.BASE_URL ?? 'http://localhost:5173';
// SMTP_HOST set here ⇒ playwright.config.ts forwarded it ⇒ the API is armed.
const emailArmed = Boolean(process.env.SMTP_HOST);
/* eslint-enable no-restricted-syntax */

const webOrigin = new URL(baseURL).origin;

// Mailpit HTTP UI/REST API — the docker-compose.dev.yml service's fixed port.
const MAILPIT_URL = 'http://localhost:8025';

const PASSWORD = 'test-password-1234';
const NEW_PASSWORD = 'test-password-5678';

// Unique per-run emails: the reset-request per-target bound (3/h on the
// normalized address) and Mailpit leftovers from earlier runs never collide.
function uniqueEmail(label: string): string {
  return `e2e-email-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per test (the admin-platform.spec.ts idiom): the
 * register/reset-request routes are rate-limited per client IP and the
 * harness trusts the loopback proxy, so a unique `X-Forwarded-For` dodges the
 * shared bucket. Octet .123 is this suite's own — no other spec file uses it.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // process.pid namespaces each Playwright worker process (fresh workers
  // reset ipCounter); the distinct 3rd octet separates specs.
  return `10.${process.pid % 256}.123.${ipCounter % 254}`;
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

/** Probe Mailpit — armed API without a catcher is a skip, not a failure. */
async function ensureMailpitOrSkip(req: APIRequestContext): Promise<void> {
  try {
    const res = await req.get(`${MAILPIT_URL}/api/v1/messages?limit=1`, {
      failOnStatusCode: false,
    });
    if (!res.ok()) {
      test.skip(true, `Mailpit API returned ${res.status()} — skipping email round trips`);
    }
  } catch (err) {
    test.skip(
      true,
      `Mailpit unreachable at ${MAILPIT_URL} — skipping email round trips (${(err as Error).message})`,
    );
  }
}

interface MailpitListMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

/**
 * Poll `GET /api/v1/messages` until a message to `to` with `subject` shows
 * up, then fetch its full body and return the plain-text part. Dispatch is
 * fire-and-forget post-commit, so arrival is eventual (normally <1s).
 */
async function waitForEmailText(
  req: APIRequestContext,
  to: string,
  subject: string,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const listRes = await req.get(`${MAILPIT_URL}/api/v1/messages?limit=50`);
    expect(listRes.ok(), 'Mailpit message list').toBe(true);
    const list = (await listRes.json()) as { messages: MailpitListMessage[] };
    const match = list.messages.find(
      (m) => m.Subject === subject && m.To.some((t) => t.Address === to),
    );
    if (match) {
      const msgRes = await req.get(`${MAILPIT_URL}/api/v1/message/${match.ID}`);
      expect(msgRes.ok(), `Mailpit message ${match.ID}`).toBe(true);
      const msg = (await msgRes.json()) as { Text: string };
      return msg.Text;
    }
    if (Date.now() > deadline) {
      throw new Error(`No "${subject}" mail for ${to} arrived in Mailpit within 15s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Pull the first URL containing `path` out of the plain-text mail body. */
function extractLink(text: string, path: string): string {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  const link = urls.find((u) => u.includes(path));
  expect(link, `no ${path} link in email body:\n${text}`).toBeTruthy();
  return link as string;
}

/**
 * REQ-3.9: the token rides the URL FRAGMENT (never a query string, so it
 * never reaches either origin's server logs) and the link lands on the
 * Playwright web origin (the WEB_BASE_URL wiring in playwright.config.ts).
 */
function assertTokenFragmentLink(link: string, path: string): void {
  expect(link).toContain(`${path}#token=`);
  const url = new URL(link);
  expect(url.origin).toBe(webOrigin);
  expect(url.pathname).toBe(path);
  expect(url.search).toBe(''); // query-string carriage regression fails here
  expect(url.hash).toMatch(/^#token=./);
}

test.describe('transactional-email', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );
  test.skip(
    !emailArmed,
    'Email not armed (SMTP_HOST unset — the API booted unconfigured); see the file header to arm.',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
    await ensureMailpitOrSkip(page.request);
    // Unique forged client IP for every BROWSER request in this test (the
    // loopback proxy is trusted) — UI-driven register/reset-request calls get
    // their own limiter buckets, like the API helpers' per-call header.
    await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  });

  test('password reset round trip: request → emailed link → new password works, old fails', async ({
    page,
  }: {
    page: Page;
  }) => {
    test.setTimeout(60_000);

    const email = await registerUser(page.request, 'reset');

    // Request a reset from the public page (no-enumeration copy on success).
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText(/a reset link is on its way/)).toBeVisible();

    // Fetch the mail via Mailpit REST and assert the fragment link shape.
    const mailText = await waitForEmailText(page.request, email, 'Reset your Tradr password');
    const resetLink = extractLink(mailText, '/reset-password');
    assertTokenFragmentLink(resetLink, '/reset-password');

    // Follow the link (fragment intact) and set the new password.
    await page.goto(resetLink);
    await expect(page.getByText('Set a new password')).toBeVisible();
    await page.getByLabel('New password').fill(NEW_PASSWORD);
    await page.getByLabel('Confirm password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByText('Your password has been reset.')).toBeVisible();

    // Old password fails, new one works (REQ-4.6).
    const oldLogin = await page.request.post('/api/auth/login', {
      data: { email, password: PASSWORD },
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(oldLogin.status(), 'old password after reset').toBe(401);
    const newLogin = await page.request.post('/api/auth/login', {
      data: { email, password: NEW_PASSWORD },
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(newLogin.status(), 'new password after reset').toBe(200);
  });

  test('verification round trip: UI register → check-your-email → emailed link → gesture verify → settings Verified', async ({
    page,
  }: {
    page: Page;
  }) => {
    test.setTimeout(60_000);

    const email = uniqueEmail('verify');

    // Register through the REAL form — this spec owns the UI-register flow, and
    // it enters it the way an emailed signup link does: a cold, logged-out load
    // straight onto /register.
    //
    // That load used to bounce to /login?expired=true. /register mounted useAuth,
    // and a logged-out me-query's 401 trips the api client's one-shot
    // interception, so the form was reachable only by clicking Register from
    // inside /login and this spec had to go the long way round. It no longer
    // mounts it — the same reason the token pages never did (SF-3).
    await page.goto('/register');
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByText('Create an account')).toBeVisible();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Register' }).click();

    // Armed instance ⇒ 201 with emailVerified:false ⇒ the Task 14
    // check-your-email state (auto-login kept; the button is the only exit).
    await expect(page.getByText('Check your email')).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // Fetch the verification mail and assert the fragment link shape.
    const mailText = await waitForEmailText(page.request, email, 'Verify your email address');
    const verifyLink = extractLink(mailText, '/verify-email');
    assertTokenFragmentLink(verifyLink, '/verify-email');

    // Exit the check-your-email state where the journey needs the dashboard.
    await page.getByRole('button', { name: 'Continue to dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Land on the verify page: the GET consumes nothing — the explicit user
    // gesture does (REQ-4.8).
    await page.goto(verifyLink);
    await page.getByRole('button', { name: 'Verify my email' }).click();
    await expect(page.getByText('Email verified.')).toBeVisible();

    // Settings Account shows the neutral Verified badge; the resend
    // affordance is gone (Task 15). Scoped to main — the sidebar footer also
    // renders the account email (strict-mode).
    await page.goto('/settings/account');
    const main = page.getByRole('main');
    await expect(main.getByText(email)).toBeVisible();
    await expect(main.getByText('Verified', { exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Resend verification email' })).toHaveCount(0);
  });
});

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * hosted-platform e2e suite (Task 22).
 *
 * The self-host DEFAULT topology, end-to-end through the booted stack. The e2e
 * API boots with no gated capability configured (no CORS_ALLOWED_ORIGINS /
 * REDIS_URL / OBJECT_STORAGE_* / DIRECT_DATABASE_URL — see
 * e2e/playwright.config.ts), so a registered user's `session` cookie is
 * `SameSite=Lax` (never `SameSite=None`) and same-origin authenticated
 * navigation works with no CORS — byte-for-byte today's behavior (REQ-1.6,
 * REQ-5).
 *
 * The split-origin ON topology is covered as a targeted INTEGRATION test
 * (apps/api/src/app.split-origin.test.ts) driven via app.request() with explicit
 * Origin/Referer headers, NOT a two-real-browser-origin Playwright setup: the
 * default harness is single-origin and CI pins CORS off. The shared-Redis budget
 * (REQ-7.3) and the reset-password-email-unconfigured (REQ-8) legs are proved by
 * their real-service integration tests
 * (apps/api/src/middleware/rate-limit.redis-store.test.ts,
 * apps/api/src/cli/tradr.integration.test.ts).
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(): string {
  return `e2e-hosted-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

// A unique, non-loopback IP per register call (the changelog/admin idiom):
// /register is rate-limited per client IP and the harness trusts the loopback
// proxy, so a unique X-Forwarded-For dodges the shared bucket. The distinct 3rd
// octet (117) keeps this suite's IPs off the other suites'. process.pid
// namespaces each Playwright worker so re-runs never replay the low IPs.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.117.${ipCounter % 254}`;
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

test.describe('hosted-platform — self-host default parity', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test('a registered session cookie is SameSite=Lax and authenticated nav works', async ({
    page,
  }) => {
    await ensureStackOrSkip(page.request);

    const res = await page.request.post('/api/auth/register', {
      data: { email: uniqueEmail(), password: PASSWORD },
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status(), 'register').toBe(201);

    // The self-host default session cookie is SameSite=Lax; split-origin
    // SameSite=None is never emitted with no CORS allow-list (REQ-5.2 / 1.6).
    const sessionCookie = res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value)
      .find((v) => v.startsWith('session='));
    expect(sessionCookie, 'session Set-Cookie present').toBeTruthy();
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).not.toMatch(/SameSite=None/i);
    expect(sessionCookie).toMatch(/HttpOnly/i);

    // Same-origin authenticated navigation works with no CORS layer.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
    const meRes = await page.request.get('/api/auth/me');
    expect(meRes.status()).toBe(200);
  });
});

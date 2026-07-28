import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * observability e2e suite — the graceful-absence invariant (REQ-1.2).
 *
 * Per the Testing Strategy > End-to-End ("remove all observability config →
 * runs without errors"): against the booted stack with NO telemetry config (the
 * existing default — see e2e/playwright.config.ts, which sets none of the
 * observability env vars and adds no /config.js), assert the defining
 * graceful-absence invariant:
 *
 *   • the app loads,
 *   • NO PostHog SDK <script> is present (no `script[src*="posthog"]`),
 *   • NO PostHog network request is made (observed via page.on('request')), and
 *   • NO telemetry-related console errors occur.
 *
 * Why the default stack already IS the unconfigured stack: frontend telemetry
 * is delivered at runtime via /config.js → window.__TRADR_CONFIG__
 * (apps/web/src/lib/telemetry/config.ts). The container entrypoint rewrites
 * /config.js on start, but Vite dev (what the e2e webServer boots) serves no
 * /config.js (public/config.js is git-ignored and absent in dev). So
 * window.__TRADR_CONFIG__ is undefined, isPostHogClientConfigured() is false,
 * and initPostHogClient (main.tsx) no-ops: posthog-js is never dynamically
 * imported (its gate returns before the await import). This test proves that
 * absence end-to-end — no new webServer entry, no apiEnv change.
 *
 * ── HONEST SCOPE NOTE (no silent cap) ──────────────────────────────────────
 *
 * This automates ONLY the unconfigured half. The configured-path half —
 * "events appear in the PostHog dashboard" — is MANUAL operator verification
 * against the live vendor dashboard, NOT an automated E2E: automating it would
 * require live vendor accounts/keys in CI, which violates REQ-1.5's "no test
 * requires a live vendor." The configured path is instead covered
 * deterministically by the unit/integration layers (vi.stubGlobal / stubbed SDK
 * clients, and the dev public/config.js seam), not by this spec. That boundary
 * is stated here so the coverage gap is visible, not implied-covered.
 */

// A telemetry vendor name in free text (console messages / errors). Used to
// scope the "no telemetry console errors" assertion: the unconfigured dev stack
// emits unrelated noise — a /config.js 404 and a 401 from the /api/auth/me
// probe — which is expected and NOT a telemetry fault, so it is excluded.
const TELEMETRY_RE = /posthog/i;

/**
 * True only for a request to a PostHog VENDOR HOST (SDK chunk or ingestion
 * beacon). Matched on the URL hostname, NOT the full URL — Vite dev serves the
 * app's own gated-off telemetry source modules by path (e.g.
 * http://localhost:5173/src/lib/telemetry/posthog.ts), and those same-origin
 * module fetches are normal app loading, not vendor traffic.
 */
function isVendorTelemetryRequest(url: string): boolean {
  try {
    return TELEMETRY_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Probe the stack — if the API is unreachable (no booted stack), skip
 * gracefully. Same guard as the other live suites (wallet-billing /
 * admin-platform). A 401 from /api/auth/me (unauthenticated) is < 500, so on
 * the booted stack this does NOT skip — the login route still renders the form,
 * which is all the graceful-absence boot invariant needs.
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
// The graceful-absence boot invariant is viewport-agnostic (telemetry init
// runs once at module load in main.tsx, before any render). Run it once on the
// canonical desktop chromium project, matching the wallet-billing /
// admin-platform suite gate.
// ===========================================================================

test.describe('observability — graceful absence (unconfigured stack)', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('no PostHog SDK, no telemetry network, no telemetry console errors', async ({ page }) => {
    // Collectors wired BEFORE the first navigation so nothing fires unobserved.
    const telemetryRequests: string[] = [];
    const consoleErrors: string[] = [];

    page.on('request', (req) => {
      if (isVendorTelemetryRequest(req.url())) telemetryRequests.push(req.url());
    });
    // Console errors and uncaught page exceptions — a telemetry init throwing
    // would surface as one of these.
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    // The app loads: the public login route renders its form (proves the SPA
    // mounted and main.tsx ran — where initPostHogClient lives).
    await page.goto('/login');
    await expect(page.locator('#email')).toBeVisible();
    await page.waitForLoadState('networkidle');

    // Exercise one CLIENT-SIDE navigation (TanStack router onResolved fires) so
    // the "no telemetry network" assertion holds across a route change, not
    // just the entry load.
    await page.getByRole('link', { name: 'Register' }).click();
    await expect(page).toHaveURL(/\/register$/);
    await page.waitForLoadState('networkidle');

    // (1) posthog-js is a dynamic-import chunk gated off here — assert no such
    // script tag is present.
    await expect(page.locator('script[src*="posthog"]')).toHaveCount(0);

    // (2) No request was made to a PostHog host (SDK chunk or ingestion beacon).
    expect(
      telemetryRequests,
      `unexpected telemetry network request(s): ${telemetryRequests.join(', ')}`,
    ).toEqual([]);

    // (3) No telemetry-related console errors. Scoped to vendor-named messages:
    // the unconfigured dev stack legitimately logs unrelated noise (the
    // /config.js 404 and the 401 auth probe) which is NOT a telemetry fault.
    const telemetryErrors = consoleErrors.filter((text) => TELEMETRY_RE.test(text));
    expect(
      telemetryErrors,
      `unexpected telemetry console error(s): ${telemetryErrors.join(' | ')}`,
    ).toEqual([]);
  });
});

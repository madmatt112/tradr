import { expect, test } from '@playwright/test';

/**
 * PWA installability e2e suite (design C7, Requirements 1.5, 1.6, 4.1, 9.1).
 *
 * These cases run against the BUILT SPA served by `vite preview`
 * (playwright.config.ts) — the only serving path where the production service
 * worker registers (`import.meta.env.PROD`) and where the `.webmanifest` name
 * makes the preview server emit `application/manifest+json` (mrmime 2.0.1). They
 * need no authenticated session and no API seed: `/` serves index.html with the
 * manifest link, the two theme-color metas and the boot-theme script on every
 * route, and the worker registers after first render regardless of the route the
 * SPA lands on.
 *
 * The suite opts the worker back in with `test.use({ serviceWorkers: 'allow' })`
 * (design D7, Requirement 9.3); the global config blocks workers for every other
 * spec so their `page.route` stubs keep reaching the page. `colorScheme: 'light'`
 * fixes the system scheme so case 4's dark cookie genuinely differs from it.
 *
 * It is Chromium-desktop only: `context.newCDPSession` and
 * `Page.getInstallabilityErrors` are Chromium-only methods, and the Mobile Chrome
 * project's iPhone 13 descriptor runs WebKit (`defaultBrowserType`), so the suite
 * skips there. The iphone-13 project never collects it (its testMatch is
 * drawer.mobile only).
 *
 * It runs on the suite's normal headless Chromium (no `channel` override). A
 * round forced `channel: 'chromium'` (the full browser / new headless) and was
 * reverted: it did not register the worker on the CI runner either, and the full
 * browser reports `Page.getInstallabilityErrors` as `[{ errorId: 'in-incognito' }]`
 * because Playwright drives every context off-the-record — which broke case 1. The
 * default `chrome-headless-shell` returns `[]` and registers the worker in every
 * local run (the shell, the full browser headed, and a persistent context all
 * activate it in < 2s against this same preview build).
 *
 * These cases assert the PRODUCTION APP's own registration (main.tsx →
 * registerServiceWorker, on `load`): no test-side `register()`. Locally that
 * resolves `.ready` in < 2s. On the GitHub Actions runner it does NOT — the app's
 * load-time registration is dropped (getRegistration stays null for 8s), so cases
 * 1 and 3 hang on `.ready` exactly as pwa-upgrade.spec.ts does. A round-4
 * diagnostic proved an EXPLICIT in-page `register('/sw.js')` DOES resolve and
 * activate the worker on the runner, so the worker can run there — only the app's
 * initial-load registration is lost under the runner's headless Chromium. That
 * masking diagnostic was removed so the check is not falsely green; the runner
 * wall is ESCALATED (needs real Chrome on the e2e jobs or a post-deploy synthetic
 * check). Unreproducible locally.
 */

test.use({ serviceWorkers: 'allow', colorScheme: 'light' });

test.describe('pwa installability', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Chromium desktop only — CDP installability over a registering worker.',
  );

  test('1 — Chrome reports no installability errors on /', async ({ page, context }) => {
    await page.goto('/');
    // The worker must be active before Chrome's installability pipeline settles.
    await page.evaluate(() => navigator.serviceWorker.ready);

    const client = await context.newCDPSession(page);
    // Poll: the pipeline runs in the background after the manifest and worker are
    // in place, so the first call can precede its verdict.
    await expect
      .poll(async () => (await client.send('Page.getInstallabilityErrors')).installabilityErrors, {
        timeout: 15_000,
      })
      .toEqual([]);
  });

  test('2 — the manifest is served as application/manifest+json', async ({ page }) => {
    const response = await page.request.get('/manifest.webmanifest');
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('application/manifest+json');
  });

  test('3 — navigator.serviceWorker.ready resolves with an active worker', async ({ page }) => {
    await page.goto('/');
    const hasActiveWorker = await page.evaluate(() =>
      navigator.serviceWorker.ready.then((registration) => registration.active !== null),
    );
    expect(hasActiveWorker).toBe(true);
  });

  test('4 — a dark cookie overrides a light scheme on both theme-color metas', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: 'tradr_theme', value: 'dark', url: baseURL ?? 'http://localhost:5173' },
    ]);
    await page.goto('/');

    const contents = await page.evaluate(() =>
      Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((meta) =>
        meta.getAttribute('content'),
      ),
    );
    expect(contents).toEqual(['#0c0d0f', '#0c0d0f']);
  });
});

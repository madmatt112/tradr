import { expect, test, type Page } from '@playwright/test';

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
 * `channel: 'chromium'` opts this spec into Chromium's new headless mode. Without
 * it, Playwright's default headless run uses the stripped-down
 * `chrome-headless-shell` binary (playwright-core registry getExecutableName:
 * `headless ? 'chromium-headless-shell' : 'chromium'`), which never registers a
 * service worker — so on the CI runner `navigator.serviceWorker.ready` hung to a
 * 30s timeout while every non-worker case passed. The new headless mode is the
 * full browser, and `playwright install chromium` already downloads that binary
 * (registry resolveBrowsers installs both), so no extra CI install is needed. The
 * override is scoped to this file, not the whole suite.
 */

test.use({ serviceWorkers: 'allow', colorScheme: 'light', channel: 'chromium' });

/**
 * Runner-only diagnostic. Service workers register only in a secure context
 * (`https` or `localhost`/`127.0.0.1`), so log the live origin and
 * `isSecureContext` to rule that in or out at a glance. Also snapshot the
 * registration lifecycle (polled briefly, exiting as soon as a worker is active)
 * so a CI run shows whether registration never started, stalled mid-install, or
 * activated — the config alone cannot answer that.
 */
async function logPwaDiagnostic(page: Page): Promise<void> {
  const diag = await page.evaluate(async () => {
    const base = {
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      swSupported: 'serviceWorker' in navigator,
    };
    if (!('serviceWorker' in navigator)) return { ...base, registration: 'no-sw-api' as const };
    const deadline = Date.now() + 8000;
    let snapshot: Record<string, string | null> | null = null;
    while (Date.now() < deadline) {
      const reg = await navigator.serviceWorker.getRegistration('/').catch(() => null);
      if (reg) {
        snapshot = {
          installing: reg.installing?.state ?? null,
          waiting: reg.waiting?.state ?? null,
          active: reg.active?.state ?? null,
          controller: navigator.serviceWorker.controller?.state ?? null,
        };
        if (reg.active) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ...base, registration: snapshot };
  });
  console.log(`[pwa-diagnostic] ${JSON.stringify(diag)}`);
}

test.describe('pwa installability', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Chromium desktop only — CDP installability over a registering worker.',
  );

  test('1 — Chrome reports no installability errors on /', async ({ page, context }) => {
    await page.goto('/');
    await logPwaDiagnostic(page);
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
    await logPwaDiagnostic(page);
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

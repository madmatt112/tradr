import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  buildPair,
  readEntrySrc,
  startPwaBuildServer,
  type PwaBuildServer,
} from '../support/pwa-build-server';

/**
 * Two-build upgrade harness e2e (design C7, Requirement 8.1-8.4, 3.8).
 *
 * These cases prove an installed client never strands across a build change, with
 * or without a version. The harness (e2e/support/pwa-build-server.ts) produces two
 * real production builds of apps/web and serves one at a time on port 4604, with
 * `/api/` proxied to the e2e API that playwright.config.ts boots — the one setup
 * that lets a registered service worker meet a genuine new build inside the job.
 *
 * The suite opts the worker back in with `test.use({ serviceWorkers: 'allow' })`
 * (design D7); the global config blocks workers for every other spec. It is
 * Chromium-desktop only: a registering worker over two real builds, driven with
 * `page.clock`. The Mobile Chrome project's iPhone 13 descriptor runs WebKit, so
 * the suite (and the two builds in beforeAll) skip there.
 *
 * Auth: a user is registered through `page.request`, whose cookie jar is the
 * browsing context's (Playwright), so the subsequent navigation to the harness
 * origin is authenticated. The session cookie is host-only `localhost`
 * (SameSite=Lax, dev), so it carries across the 5173 → 4604 port change.
 */

// The e2e API the harness proxies to — playwright.config.ts boots it on apiPort
// (default 3100). Hardcoded like the stub servers' own default ports, so this
// spec needs no process.env access.
const API_ORIGIN = 'http://localhost:3100';

const PASSWORD = 'test-password-1234';
// Both match the monitor's VERSION_SHAPE (/^[A-Za-z0-9.+-]{1,64}$/).
const VERSION_A = 'v9.9.9-pwa-a';
const VERSION_B = 'v9.9.9-pwa-b';
const TITLE = 'Tradr has been updated';

// A unique, non-loopback forwarded IP per auth call. The auth routes are
// rate-limited per client IP; the harness sets TRUSTED_PROXIES=127.0.0.1, so the
// limiter keys off this header rather than the shared loopback socket. (The
// drawer.mobile.spec.ts pattern — process.pid namespaces each worker process.)
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.119.${ipCounter % 254}`;
}

function uniqueEmail(label: string): string {
  return `e2e-pwa-upgrade-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * Register a user through the page's request context so its auto-session cookie
 * lands in the browsing context — the page is then authenticated without a UI
 * login (whose timers would fight the installed fake clock).
 */
async function registerAndAuth(request: APIRequestContext, label: string): Promise<void> {
  const res = await request.post('/api/auth/register', {
    data: { email: uniqueEmail(label), password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), 'register').toBe(201);
}

async function waitForWorker(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
}

async function waitForAuthShell(page: Page): Promise<void> {
  // The sidebar mounts on every authenticated route; its Dashboard link is a
  // proxy for "the shell committed and the update monitor started". Desktop
  // Chromium renders the rail directly (no mobile nav overlay).
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
}

async function liveEntrySrc(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('script[type="module"][src]');
    return el?.getAttribute('src') ?? '';
  });
}

async function shellCacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await caches.keys()).filter((key) => key.startsWith('tradr-shell-')),
  );
}

// `channel: 'chromium'` opts into Chromium's new headless mode (the full browser).
// The default headless run uses `chrome-headless-shell`, which never registers a
// service worker, so the whole two-build flow hung to its per-test timeout on the
// CI runner. `playwright install chromium` already downloads this binary, so no
// extra CI install is needed. Scoped to this file, not the whole suite.
test.use({ serviceWorkers: 'allow', channel: 'chromium' });

test.describe('pwa upgrade across two builds', () => {
  // The whole suite — the two builds included — is Chromium desktop only.
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Chromium desktop only — a registering worker driven across two real builds.',
  );
  // A generous per-test budget covers the reloads and the clock-driven poll.
  // retries: 0 — Playwright re-runs beforeAll on every retry, and beforeAll here
  // runs two full production Vite builds. A retry would rebuild both and blow the
  // dedicated job's time budget, so this suite never retries (overriding the
  // config's CI default of 1).
  test.describe.configure({ timeout: 180_000, retries: 0 });

  let tmpRoot: string | undefined;
  let builds: { a: string; b: string };
  let server: PwaBuildServer | undefined;

  test.beforeAll(async ({ browserName }) => {
    // Only Chromium runs the cases, so only Chromium pays for the two builds.
    if (browserName !== 'chromium') return;
    // Two full production builds — well over the default hook timeout.
    test.setTimeout(300_000);
    tmpRoot = mkdtempSync(join(tmpdir(), 'tradr-pwa-upgrade-'));
    builds = await buildPair(tmpRoot);
    server = await startPwaBuildServer({ builds, apiOrigin: API_ORIGIN });
  });

  test.afterAll(async () => {
    await server?.close();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('8.1 — a versioned build change prompts once and the accept boots build B', async ({
    page,
  }) => {
    if (!server) throw new Error('harness not started');
    server.serve('a', VERSION_A);
    await registerAndAuth(page.request, '81');

    // Install before the goto so the monitor's poll interval runs on the fake
    // clock (the app-update-prompt.spec.ts pattern).
    await page.clock.install();
    await page.goto(`${server.url}/dashboard`);
    await waitForWorker(page);
    await waitForAuthShell(page);
    expect(await liveEntrySrc(page)).toBe(readEntrySrc(builds.a));

    // The served build changes under the open tab.
    server.serve('b', VERSION_B);

    // Drive the visible-tab interval: the poll finds B and the prompt shows once.
    await page.clock.fastForward(5 * 60_000);
    await expect(page.getByText(TITLE)).toBeVisible();
    await expect(page.getByText(`${VERSION_A} → ${VERSION_B}`)).toBeVisible();

    // Accept: the reload is served from the network and boots build B.
    await Promise.all([
      page.waitForEvent('load'),
      page.getByRole('button', { name: 'Reload' }).click(),
    ]);
    await waitForWorker(page);
    await waitForAuthShell(page);
    expect(await liveEntrySrc(page)).toBe(readEntrySrc(builds.b));
    expect(await liveEntrySrc(page)).not.toBe(readEntrySrc(builds.a));

    // The prompt does not return: this tab now boots equal to the served build.
    await page.clock.fastForward(10 * 60_000);
    await expect(page.getByText(TITLE)).toHaveCount(0);
  });

  test('8.2 — with no version the next load boots build B and caches nothing', async ({ page }) => {
    if (!server) throw new Error('harness not started');
    server.serve('a', undefined);

    await page.goto(`${server.url}/login`);
    await waitForWorker(page);

    // The served build changes; a reload is served from the network.
    server.serve('b', undefined);
    await page.reload();
    await waitForWorker(page);

    expect(await liveEntrySrc(page)).toBe(readEntrySrc(builds.b));
    // APP_VERSION unset ⇒ the worker stores nothing and deletes any cache (Req 3.7).
    expect(await shellCacheKeys(page)).toEqual([]);
  });

  test('8.3 — a vanished lazy chunk recovers onto build B in one guarded reload', async ({
    page,
  }) => {
    if (!server) throw new Error('harness not started');
    server.serve('a', VERSION_A);
    await registerAndAuth(page.request, '83');

    await page.goto(`${server.url}/dashboard`);
    await waitForWorker(page);
    await waitForAuthShell(page);

    // The served build changes before the lazy route is ever requested, so build
    // A's ChangelogPage chunk no longer exists on the server.
    server.serve('b', VERSION_B);

    let loadCount = 0;
    page.on('load', () => {
      loadCount += 1;
    });

    // Client-side navigation to Changelog: build A's chunk 404s, the §29 boundary
    // spends its one guarded reload, and the reload lands on build B where the
    // chunk is served — the heading renders, no error-boundary fallback.
    await page.getByRole('link', { name: 'Changelog' }).click();
    await expect(page.getByRole('heading', { name: 'Changelog' })).toBeVisible();
    expect(loadCount).toBe(1);
    await expect(page.getByTestId('chunk-load-fallback')).toHaveCount(0);
    expect(await liveEntrySrc(page)).toBe(readEntrySrc(builds.b));
  });
});

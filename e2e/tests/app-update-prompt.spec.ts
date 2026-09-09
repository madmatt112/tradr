import { expect, type Page, type Response } from '@playwright/test';

import { mockAppShell, SESSION_RESPONSE, test } from './fixtures/performance-fixtures';

/**
 * App-update-prompt e2e suite (REQ-11.3).
 *
 * What the harness gives us: the e2e web server serves the BUILT SPA through
 * `vite preview` (playwright.config.ts), so Vite's preload helper is present and
 * `vite:preloadError` is real; `/config.js` is a 404 by default, so the app's
 * boot version is `localdev` and the update monitor is inert unless a case wires
 * `/config.js` itself. What the harness cannot do is a second deployment — the
 * fixture below bridges that by serving a boot version to the classic
 * `<script src="/config.js">` (resourceType 'script') and a different served
 * version to the monitor's poll (resourceType 'fetch').
 *
 * Fixture composition follows the shared app-shell contract: `test` is imported
 * from `./fixtures/performance-fixtures` (mockAppShell throws otherwise), each
 * case stubs `/auth/me` and calls `mockAppShell` FIRST, then registers its own
 * `/config.js` and chunk routes AFTER it (Playwright matches handlers in reverse
 * registration order) and BEFORE the first `goto`. `routeVersionedConfig` and
 * the chunk globs match `/config.js` and `/assets/…`, both outside the `/api/`
 * backstop's scope, so they never trip the app-shell contract.
 *
 * Time is driven with `page.clock` (proof P3 verdict: page.clock passes in this
 * React 19 build): install before the first goto, fast-forward to drive the
 * 5-minute interval and the 30-second spacing without waiting.
 *
 * The suite proves the client behaviour only — the prompt, cross-tab broadcast,
 * the inert path, and chunk recovery end to end. It does NOT prove the hosted
 * static-host `_headers` / 404 behaviour (that is measured on a real deploy
 * elsewhere).
 */

const BOOT = 'v0.0.1-e2e';
const SERVED = 'v0.0.2-e2e';
const MONO_LINE = `${BOOT} → ${SERVED}`;
const TITLE = 'Tradr has been updated';

// A minimal free-tier TierState (gating off, no usage) — self-host parity, so
// no gated surface renders. Shape mirrors packages/shared TierStateSchema.
const FREE_TIER_STATE = {
  gatingEnabled: false,
  exempt: true,
  tier: 'free',
  purchasable: false,
  subscription: null,
  limits: {
    free: { accounts: null, positions: null, platformTurns: null, images: null, csvImports: null },
    pro: { accounts: null, positions: null, platformTurns: null, images: null, csvImports: null },
  },
  usage: null,
};

interface VersionedConfig {
  boot: string;
  served: string;
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * Serve `/config.js` with a mutable boot/served split on request resource type:
 * the classic `<script>` load ('script') gets the boot version; the monitor's
 * `fetch('/config.js')` poll ('fetch') gets the served version — the classic
 * script shape the monitor scrapes. Exact-pathname match with `route.fallback()`
 * (the user-feedback.spec.ts pattern) so it never shadows another `config.js`.
 * `onFetch` records what each poll was told (used by the two-tab case).
 */
async function routeVersionedConfig(
  page: Page,
  config: VersionedConfig,
  onFetch?: (served: string) => void,
): Promise<void> {
  await page.route('**/config.js', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/config.js') {
      await route.fallback();
      return;
    }
    const isScript = route.request().resourceType() === 'script';
    const version = isScript ? config.boot : config.served;
    if (!isScript) onFetch?.(config.served);
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.__TRADR_CONFIG__={"appVersion":"${version}"};`,
    });
  });
}

async function mockSession(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) => route.fulfill(json(SESSION_RESPONSE)));
}

/**
 * Stub the two billing reads the authenticated shell issues off `/positions`
 * (and the advisor conversation). `mockAppShell` stubs no `/api/billing/*`
 * route, so without this the fail-closed backstop trips on GET
 * `/api/billing/tier` the moment a case navigates to a plan-gated surface.
 */
async function mockBilling(page: Page): Promise<void> {
  await page.route('**/api/billing/config', (route) =>
    route.fulfill(json({ enabled: false, packs: [], models: [] })),
  );
  await page.route('**/api/billing/tier', (route) => route.fulfill(json(FREE_TIER_STATE)));
}

/** Count fetch-type (monitor-poll) requests to `/config.js`; script loads never count. */
function countConfigFetches(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.resourceType() !== 'fetch') return;
    try {
      if (new URL(request.url()).pathname === '/config.js') count += 1;
    } catch {
      // Not a parseable URL target — ignore.
    }
  });
  return () => count;
}

/**
 * A `page.waitForResponse` predicate matching a `/config.js` response of one
 * resource type: `'script'` for the classic boot `<script>` load, `'fetch'` for
 * a monitor poll. Bind the returned promise BEFORE the action that triggers the
 * request (goto or clock fast-forward) so the response can never be missed while
 * the fake clock drives things.
 */
function configResponse(resourceType: 'script' | 'fetch') {
  return (response: Response): boolean => {
    if (response.request().resourceType() !== resourceType) return false;
    try {
      return new URL(response.url()).pathname === '/config.js';
    } catch {
      return false;
    }
  };
}

/** Serve a 404 for a single hashed chunk (never the app shell's own JS). */
async function route404Chunk(page: Page, glob: string): Promise<void> {
  await page.route(glob, (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }),
  );
}

/**
 * The authenticated shell has rendered (its sidebar mounts on every `_auth`
 * route) — a proxy for "React committed and UpdatePrompt's mount effect started
 * the monitor", which must be true before the clock is fast-forwarded.
 */
async function waitForAuthShell(page: Page): Promise<void> {
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
}

test.describe('app update prompt', () => {
  // Viewport-agnostic cases (prompt / broadcast / inert / chunk), so the suite
  // runs on every project — including Mobile Chrome (iPhone 13 = webkit) for
  // engine coverage.
  test.beforeEach(async ({ page }) => {
    // FIRST, so the backstop is matched LAST; per-case routes register after.
    await mockAppShell(page);
    await mockSession(page);
    await mockBilling(page);
  });

  test('1 — the prompt appears and polling stops once an update is known', async ({ page }) => {
    const config: VersionedConfig = { boot: BOOT, served: SERVED };
    await routeVersionedConfig(page, config);
    const configFetches = countConfigFetches(page);

    await page.clock.install();
    await page.goto('/dashboard');
    await waitForAuthShell(page);

    // The first poll is the visible-tab interval at boot + 5 min.
    await page.clock.fastForward(5 * 60_000);
    await expect(page.getByText(TITLE)).toBeVisible();
    await expect(page.getByText(MONO_LINE)).toBeVisible();
    expect(configFetches()).toBe(1);

    // update-available removed the interval, so ten more minutes adds no poll.
    await page.clock.fastForward(10 * 60_000);
    expect(configFetches()).toBe(1);
  });

  test('2 — Reload keeps the route and clears the prompt', async ({ page }) => {
    const config: VersionedConfig = { boot: BOOT, served: SERVED };
    await routeVersionedConfig(page, config);

    await page.clock.install();
    await page.goto('/positions');
    await waitForAuthShell(page);
    await expect(page).toHaveURL(/\/positions/);

    await page.clock.fastForward(5 * 60_000);
    await expect(page.getByText(TITLE)).toBeVisible();

    // The deploy completes for this tab: the served version becomes its boot
    // version, so the reloaded document boots equal and never prompts.
    config.boot = config.served;
    await Promise.all([
      page.waitForEvent('load'),
      page.getByRole('button', { name: 'Reload' }).click(),
    ]);

    await waitForAuthShell(page);
    await expect(page).toHaveURL(/\/positions/);
    await page.clock.fastForward(10 * 60_000);
    await expect(page.getByText(TITLE)).toHaveCount(0);
  });

  test('3 — Not now dismisses the prompt and it stays gone', async ({ page }) => {
    await routeVersionedConfig(page, { boot: BOOT, served: SERVED });

    await page.clock.install();
    await page.goto('/dashboard');
    await waitForAuthShell(page);

    await page.clock.fastForward(5 * 60_000);
    await expect(page.getByText(TITLE)).toBeVisible();

    await page.getByRole('button', { name: 'Not now' }).click();
    // sonner's exit-unmount runs on the (fake) clock; nudge it so the toast
    // actually leaves the DOM before asserting it is gone.
    await page.clock.fastForward(1_000);
    await expect(page.getByText(TITLE)).toHaveCount(0);

    await page.clock.fastForward(10 * 60_000);
    await expect(page.getByText(TITLE)).toHaveCount(0);
  });

  test('4 — a second tab learns of the update via broadcast', async ({ page, context }) => {
    // Tab 2 — same context as tab 1 (shared BroadcastChannel and, per Playwright,
    // one fake clock for the whole BrowserContext). Opened first so it is always
    // torn down in `finally`, even when an assertion throws.
    const tab2 = await context.newPage();
    try {
      // Tab 1 — the tab that polls and finds the update.
      await routeVersionedConfig(page, { boot: BOOT, served: SERVED });

      // Tab 2's own /config.js serves ITS boot version for BOTH the script and
      // the poll, so its own poll never finds an update; any prompt it shows can
      // only have come from the broadcast. It sits on /login (public, mounts
      // UpdatePrompt from __root, needs no authed shell).
      const tab2Served: string[] = [];
      await routeVersionedConfig(tab2, { boot: BOOT, served: BOOT }, (served) =>
        tab2Served.push(served),
      );
      // /login reads /api/config for the registration flag; stub it so tab 2 is
      // hermetic (it has no mockAppShell — it needs no authenticated shell).
      await tab2.route('**/api/config', (route) =>
        route.fulfill(json({ registrationEnabled: true, advisorEnabled: true })),
      );

      // The clock is context-wide, so it must be installed BEFORE either tab
      // navigates: a tab that boots on the real clock schedules its poll interval
      // on real time and `fastForward` would never fire it.
      await page.clock.install();

      // Boot tab 2 fully before advancing: its classic <script src="/config.js">
      // is served (boot version is BOOT, so the monitor is active — not inert)
      // and its shell has rendered (the mount effect has started the poll
      // interval under the fake clock). Bind the boot response BEFORE the goto.
      const tab2Booted = tab2.waitForResponse(configResponse('script'));
      await tab2.goto('/login');
      await tab2Booted;
      await expect(tab2.getByRole('button', { name: 'Log in' })).toBeVisible();

      // Boot tab 1 fully: its authenticated shell has rendered, so its monitor's
      // poll interval is likewise registered under the fake clock.
      const tab1Booted = page.waitForResponse(configResponse('script'));
      await page.goto('/dashboard');
      await tab1Booted;
      await waitForAuthShell(page);

      // Advance the shared clock. Bind BOTH polls' responses BEFORE the action so
      // neither can be missed: tab 1's poll finds SERVED and broadcasts; tab 2's
      // poll finds BOOT (no update) and only hears via the channel.
      const tab1Polled = page.waitForResponse(configResponse('fetch'));
      const tab2Polled = tab2.waitForResponse(configResponse('fetch'));
      await page.clock.fastForward(5 * 60_000);
      await tab1Polled;
      await tab2Polled;

      await expect(page.getByText(TITLE)).toBeVisible();
      await expect(tab2.getByText(TITLE)).toBeVisible();
      await expect(tab2.getByText(MONO_LINE)).toBeVisible();

      // Every poll tab 2 made returned its own boot version — it never self-detected.
      expect(tab2Served.length).toBeGreaterThan(0);
      expect(tab2Served.every((v) => v === BOOT)).toBe(true);
    } finally {
      await tab2.close();
    }
  });

  test('5 — no config.js means the monitor never polls (inert)', async ({ page }) => {
    // Deliberately NO routeVersionedConfig: the preview serves no /config.js, so
    // the boot version is `localdev` and the monitor is permanently inert.
    const configFetches = countConfigFetches(page);

    await page.clock.install();
    await page.goto('/dashboard');
    await waitForAuthShell(page);

    await page.clock.fastForward(5 * 60_000);
    await page.getByRole('link', { name: 'Positions' }).click();
    await expect(page).toHaveURL(/\/positions/);
    await page.clock.fastForward(10 * 60_000);

    expect(configFetches()).toBe(0);
    await expect(page.getByText(TITLE)).toHaveCount(0);
  });

  test('6 — a vanished route chunk reloads once, then offers recovery', async ({
    page,
    browserName,
  }) => {
    // Recovery cache-busts the failed chunk using the URL in the error message
    // before reloading; webkit's message ("Importing a module script failed.")
    // carries no URL, so the manual Reload takes the plain-reload path, which is
    // flaky under load. The recovery loop is covered on chromium, whose message
    // carries the URL.
    test.skip(
      browserName === 'webkit',
      'Plain-reload recovery is flaky on webkit; covered on chromium.',
    );

    // ChangelogPage fires this once its releases query resolves.
    await page.route('**/api/changelog/viewed', (route) => route.fulfill(json({})));
    // Only the changelog chunk 404s — never the app shell's own JS, never /api.
    await route404Chunk(page, '**/assets/ChangelogPage-*.js');

    let loadCount = 0;
    page.on('load', () => {
      loadCount += 1;
    });

    await page.goto('/dashboard');
    await waitForAuthShell(page);
    const loadsAfterInitial = loadCount;

    // Navigate to /changelog: the chunk 404s, the boundary spends its one
    // automatic reload (one extra document load), the reload's chunk 404s again,
    // the guard is spent, and the fallback renders.
    await page.getByRole('link', { name: 'Changelog' }).click();
    await expect(page.getByTestId('chunk-load-fallback')).toBeVisible();
    expect(loadCount).toBe(loadsAfterInitial + 1);

    // Recover: the chunk is available again, the manual Reload succeeds.
    await page.unroute('**/assets/ChangelogPage-*.js');
    await page.getByTestId('chunk-load-fallback-reload').click();
    await expect(page.getByRole('heading', { name: 'Changelog' })).toBeVisible();
  });

  test('7 — a vanished Shiki chunk degrades in place with no reload', async ({ page }) => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    // The fixed set of first-render requests the advisor conversation issues.
    await page.route(/\/api\/advisor\/conversations(\?.*)?$/, (route) =>
      route.fulfill(json({ items: [], nextCursor: null })),
    );
    await page.route(new RegExp(`/api/advisor/conversations/${conversationId}$`), (route) =>
      route.fulfill(
        json({
          conversation: {
            id: conversationId,
            userId: SESSION_RESPONSE.id,
            title: 'Fenced code',
            personaId: null,
            providerId: 'openai',
            model: 'gpt-4',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          messages: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              conversationId,
              role: 'assistant',
              contentParts: [{ type: 'text', text: '```ts\nconst answer = 42;\n```' }],
              promptTokens: null,
              completionTokens: null,
              clientMessageId: null,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    await page.route('**/api/advisor/personas', (route) => route.fulfill(json({ items: [] })));
    await page.route('**/api/advisor/provider-keys', (route) => route.fulfill(json({ items: [] })));
    await page.route('**/api/advisor/trade-data-consent', (route) => route.fulfill(json({})));
    // /api/billing/config and /api/billing/tier are stubbed in beforeEach.
    // Only the Shiki chunk 404s — never markdown-*.js or the advisor chunk.
    await route404Chunk(page, '**/assets/ShikiCodeBlock-*.js');

    let loadCount = 0;
    page.on('load', () => {
      loadCount += 1;
    });

    await page.goto(`/advisor/${conversationId}`);

    // The inline boundary (recovery="inline") renders the raw <pre> plus the
    // muted line — and never reloads (the composer may hold unsaved text).
    await expect(
      page.getByText('Syntax highlighting is unavailable until you reload.'),
    ).toBeVisible();
    await expect(page.locator('pre', { hasText: 'const answer = 42;' })).toBeVisible();
    expect(loadCount).toBe(1);
  });
});

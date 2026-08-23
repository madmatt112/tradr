import fs from 'node:fs';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

import { mockAppShell, PERF_URL, SESSION_RESPONSE, test } from './fixtures/performance-fixtures';

/**
 * Coverage for `mockAppShell` itself (e2e/tests/fixtures/performance-fixtures.ts).
 *
 * Every other spec in this suite treats that helper as the authenticated app
 * shell. Nothing checked that it actually WAS one. When a stub was missing the
 * request 401'd, the api client redirected the whole app to /login, and the
 * spec carried on asserting against the login page — green, and testing
 * nothing. It happened four times on this branch before anyone noticed.
 *
 * So the contract gets its own tests: the shell is fully answered on the routes
 * the mocked specs visit, and a request it does not answer fails the test
 * instead of redirecting.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function mockSession(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill(json(SESSION_RESPONSE)));
}

/** Every `.ts` file under the suite's own test root, recursively. */
function suiteSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...suiteSources(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

test.describe('mockAppShell', () => {
  for (const [label, url] of [
    ['/dashboard', '/dashboard'],
    ['/performance', PERF_URL],
  ] as const) {
    test(`answers every request the shell makes on ${label}`, async ({ page }) => {
      const unauthorized: string[] = [];
      page.on('response', (response) => {
        if (response.status() === 401) unauthorized.push(new URL(response.url()).pathname);
      });

      await mockAppShell(page);
      await mockSession(page);

      // A request the fixture does not answer never gets one: the backstop
      // throws and this test fails naming the method and path. That is the
      // assertion — no list of endpoints to keep in step with the app here,
      // because the app itself decides what it asks for.
      await page.goto(url);
      await expect(page.getByTestId('drawer-toggle')).toBeVisible();
      // The shell paints well before it has finished asking for things — the
      // widgets fetch after their grid mounts. Without a wait the test can end
      // while the last requests are still in flight, and a backstop throw after
      // the body has returned is dropped: the missing stub goes unreported,
      // which is the failure this whole file exists to prevent.
      //
      // A fixed window rather than `waitForLoadState('networkidle')`, because
      // /dashboard is never idle: the grid re-persists its layout on a 300ms
      // debounce, the layout stub echoes the same static body back, and the
      // grid re-normalises and persists again, for as long as the page is open.
      // Measured, every request the shell makes is issued within ~900ms of the
      // navigation, and an unstubbed one throws the moment it is made.
      await page.waitForTimeout(2_000);

      // Belt and braces for the other way in: a stub that exists but answers
      // 401 would redirect just as silently, and the backstop never sees it.
      expect(unauthorized, 'the mocked session must not 401 anywhere').toEqual([]);
      expect(page.url(), 'the shell must not have bounced the spec to /login').not.toContain(
        '/login',
      );
    });
  }

  test('fails the test when a shell request is unstubbed', async ({ page }) => {
    // This test is SUPPOSED to fail, and the backstop is the only thing that
    // can fail it. The body is written to PASS in the fail-open world: it lets
    // the missing stub 401, waits for the redirect a 401 produces, and asserts
    // nothing whatsoever about the dashboard it was pointed at. That is the
    // defect in one test — a spec quietly running against /login.
    //
    // With the backstop the request is never answered, so no redirect ever
    // comes and the throw lands mid-wait: an expected failure, suite green.
    // Take the backstop away and the body runs to the end and passes, which
    // Playwright reports as "Expected to fail, but passed" — suite red.
    test.fail();

    await mockAppShell(page);
    await mockSession(page);
    // Drop one stub to stand in for the endpoint the fixture does not know
    // about yet — the shape every one of the four regressions took.
    await page.unroute('**/api/dashboard/totals');

    await page.goto('/dashboard');
    await page.waitForURL(/\/login/, { timeout: 20_000 });
  });

  test('refuses a page the contract fixtures are not live for', async ({ context }) => {
    // The backstop is only half the contract. The other half — catching a
    // request the app makes after the spec's last await — is teardown on the
    // `test` this file imports from the fixture module, so a spec that takes
    // `test` from `@playwright/test` gets a weaker guarantee than the helper
    // advertises, and nothing in that spec's diff looks wrong. Measured before
    // this check existed: a stray request 200ms after the body returned passed
    // green.
    //
    // A page opened by hand stands in for it here, because a spec cannot import
    // two different `test`s. It is the same hole from the other side: these
    // fixtures never saw this page, so nothing would ever read its violations.
    const unfixtured = await context.newPage();
    await expect(mockAppShell(unfixtured)).rejects.toThrow(/contract fixtures are not live/);
    await unfixtured.close();
  });

  test('no spec reaches the real network via route.continue', () => {
    // `continue()` abandons the handler chain and goes to the network, so a
    // request nothing here answers takes a real 401 against the synthetic
    // session and the api client bounces the whole app to /login — the failure
    // the backstop exists to end, past the backstop entirely.
    //
    // Seven of them were removed from ledger-balances in one pass, and what
    // stood between the next author and putting one back was a doc comment.
    // That is not a guard, so the rule gets teeth here instead.
    //
    // A test rather than an ESLint rule on purpose. `no-restricted-syntax` is
    // already blanket-disabled at the top of several specs in this directory
    // for the `process.env` selector it carries, which would switch this off
    // with it; and a selector matching `route.continue` would miss a handler
    // whose parameter is named anything else. A grep for the call misses
    // neither.
    //
    // Scoped to the test tree because that is where `page.route` handlers live;
    // e2e/support holds Node stub servers, which have no Route to continue.
    //
    // This file is IN scope, which is why the title and the message below name
    // the call without its parentheses: the check holds itself to the rule
    // rather than carving out an exemption that a real call could hide in.
    const testRoot = path.dirname(test.info().file);
    const offenders: string[] = [];

    for (const file of suiteSources(testRoot)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          // Comment lines are where the hazard is DESCRIBED — twice in this
          // suite, deliberately. A real call never starts a line with any of
          // these, so skipping them costs the check nothing.
          const code = line.trim();
          if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
          if (/\.continue\s*\(/.test(line)) {
            offenders.push(`${path.relative(testRoot, file)}:${index + 1}`);
          }
        });
    }

    expect(
      offenders,
      'A route handler here calls continue(), which abandons the handler chain and goes ' +
        'to the real network, so the request never reaches the mockAppShell backstop: it ' +
        '401s against the mocked session and the app silently redirects to /login ' +
        'mid-test, and the spec goes on asserting against the login page. Use ' +
        'route.fallback() instead — it hands the request to the next matching handler, ' +
        'and failing all of them, to the backstop that names it.',
    ).toEqual([]);
  });

  test('refuses a second install on the same page', async ({ page }) => {
    // Installing twice used to be a silent trap, which is the one thing this
    // helper must not be. The second call's backstop is registered last, so
    // Playwright reaches it FIRST — shadowing every route registered since the
    // first call, the spec's own overrides included — and it swaps in a fresh
    // record, losing whatever the first backstop had already seen. Nothing said
    // so; the spec simply started failing on a stub it had definitely
    // registered.
    await mockAppShell(page);
    await expect(mockAppShell(page)).rejects.toThrow(/already installed on this page/);
  });

  test('fails the test when the unstubbed request comes after the last await', async ({ page }) => {
    // Also SUPPOSED to fail, and for a reason the test above cannot cover.
    //
    // The backstop's throw is only reported while the spec is awaiting
    // something. A request the app fires after the spec's last await — a
    // debounce, a widget fetching once its grid has mounted — used to throw
    // into nothing: measured, teardown began 3ms after the body returned and a
    // stray 50ms later was never even issued, so the suite stayed green with a
    // missing stub. That is the same silent pass this file exists to prevent,
    // reached by timing rather than by a missing stub.
    //
    // The body below is written to PASS in that world: it schedules one
    // unstubbed request for after it has returned and asserts nothing. What
    // fails it now is teardown — the settle fixture holds the test open, the
    // request lands, the backstop records it and throws, and the recorded list
    // is asserted empty in a later fixture.
    //
    // Those two reports are belt and braces, NOT two halves of one check:
    // measured by deleting each in turn, either alone still fails this test —
    // with only the record the single error is the recorded-list assertion,
    // with only the throw it is `unstubbed request GET
    // /api/__unstubbed-after-last-await`.
    //
    // What is not redundant is WHERE the record is read. A backstop throw
    // interrupts the step in flight, so while the settle and the assertion
    // shared one fixture the throw cancelled the settle and the assertion never
    // ran at all — inert, with the throw quietly doing all the work. The read
    // has a fixture of its own now, which is what makes the second report real.
    test.fail();

    await mockAppShell(page);
    await mockSession(page);

    await page.goto('/dashboard');
    await expect(page.getByTestId('drawer-toggle')).toBeVisible();

    // Stands in for the endpoint the fixture does not know about yet, asked for
    // late. `evaluate` returns as soon as the timer is set, so the request
    // leaves the page after this test body has finished.
    await page.evaluate(() => {
      window.setTimeout(() => {
        void fetch('/api/__unstubbed-after-last-await');
      }, 200);
    });
  });
});

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
      await expect(page.getByTestId('drawer-topbar')).toBeVisible();
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
    // fails it now is teardown — the fixture settles, the request lands, the
    // backstop records it, and the recorded list is asserted empty. Take either
    // half away and this reports "Expected to fail, but passed".
    test.fail();

    await mockAppShell(page);
    await mockSession(page);

    await page.goto('/dashboard');
    await expect(page.getByTestId('drawer-topbar')).toBeVisible();

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

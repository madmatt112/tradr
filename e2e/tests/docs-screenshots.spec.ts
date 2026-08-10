import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Documentation screenshot capture.
 *
 * Regenerates every image the user-guide "Getting started" page shows, from a
 * booted stack and the sample-data fixture, in both themes. The images are the
 * output of this file rather than the input: nothing here asserts against a
 * committed baseline, so this is a generator, not a pixel-diff gate.
 *
 * ── Not a CI gate ──────────────────────────────────────────────────────────
 *
 * The whole describe is guarded behind `DOCS_SCREENSHOT_CAPTURE`. With the flag
 * UNSET — the normal `pnpm --filter @tradr/e2e test` run the CI e2e job
 * executes — every case skips, so the job pays nothing for it. To regenerate,
 * run the full stack and:
 *
 *   DOCS_SCREENSHOT_CAPTURE=1 CI=1 \
 *     pnpm --filter @tradr/e2e exec playwright test \
 *     docs-screenshots.spec.ts --project=chromium
 *
 * `CI=1` pins the chromium rendering to what a CI re-run would produce, so two
 * regenerations of the same commit are comparable. There is no
 * `--update-snapshots` here because there are no snapshots — the published
 * images are written straight into `apps/docs/src/assets/screenshots/`, and the
 * resulting working-tree change is what gets reviewed.
 *
 * ── Why the figures are quotable ───────────────────────────────────────────
 *
 * The sample-data seeder writes a fixed table of fourteen trades with literal
 * prices and absolute dates, so the numbers in these images are the same on
 * every run and a docs author can quote them in prose. The reads below assert
 * those figures rather than trusting them, so a fixture that drifts fails here
 * instead of silently changing every image.
 *
 * ── Why a failed run leaves no image behind ────────────────────────────────
 *
 * Both output directories are emptied before the first capture, and the run
 * ends by checking that exactly the manifest's files came back, each one
 * non-empty and written during this run. A surface that cannot be reached
 * therefore fails loudly at its own paint gate and leaves a hole a reader can
 * see, rather than leaving last month's image in place to be shipped as if it
 * were current.
 *
 * ── Why some surfaces are captured but never committed ─────────────────────
 *
 * Every surface below is captured and held to the same paint gate. Only the
 * ones the guide actually embeds are written into
 * `apps/docs/src/assets/screenshots/` — the rest go to a git-ignored holding
 * directory under `e2e/test-results/`.
 *
 * That split is what keeps the guide's curation from being undone. The refresh
 * workflow stages the published directory wholesale, so anything written there
 * is proposed for commit; before the split, a surface deliberately left out of
 * the repository came straight back on the next dispatch. The dashboard pair
 * was the live case: it passed its paint gate, but the Stats Summary widget
 * photographed blank at its pinned height, so the committed image would have
 * misrepresented the product. `published: false` says that in the one file
 * someone changing the capture will read, and the workflow needs no rule of its
 * own.
 *
 * Held surfaces are captured rather than dropped because the gate is the cheap
 * part, and it is the only thing proving those pages still render at all. It is
 * also how an exclusion gets revisited: the refresh workflow uploads the held
 * images as an artifact, so whether Stats Summary is fixed can be checked
 * without editing this file first.
 *
 * ── Why "painted", not "not loading" ───────────────────────────────────────
 *
 * The absence of skeletons is not the presence of content: a document that has
 * navigated but not yet rendered has no skeletons either, and a dashboard whose
 * widgets gridstack has not sized yet has none once the queries settle. Both
 * pass an absence check and both produce an image that is wrong in a way only a
 * reader notices. So every capture waits on POSITIVE evidence instead — see
 * `PAINTED_WHEN` and `paintFaults` below — and a surface that cannot produce it
 * within `PAINT_TIMEOUT_MS` fails the run rather than being photographed thin.
 *
 * STACK REQUIREMENT: the dev stack (web + api + stubs + db) must be running —
 * Playwright boots web/api/stubs via playwright.config.ts; Postgres must be
 * reachable at DATABASE_URL.
 */

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The published set — the directory `Screenshot.astro` globs, and the only one
 * the refresh workflow stages. A file here is a file the documentation ships.
 */
const PUBLISHED_DIR = path.resolve(HERE, '../../apps/docs/src/assets/screenshots');

/**
 * The held set — captured, gated, looked at, never committed. Under
 * `e2e/test-results/`, which `.gitignore` already covers, so a held image
 * cannot be staged by a `git add -A` in a contributor's tree either.
 */
const HELD_DIR = path.resolve(HERE, '../test-results/docs-screenshots-held');

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/**
 * THE MANIFEST — one entry per surface this capture visits, in the order the
 * getting-started guide meets them, and whether that guide EMBEDS it.
 *
 * It is the contract the final check reads: a surface listed here but never
 * captured fails the run, and a file in either output directory that no entry
 * names fails it too, which is what keeps a renamed surface from leaving its
 * predecessor behind.
 *
 * `published` is the whole of the curation. Setting it decides which directory
 * the image lands in, and therefore whether the refresh workflow proposes it —
 * see the header for why the two are kept apart.
 */
const SURFACES = [
  // Step 1 — create your account. The guide describes the sign-up form in
  // prose and shows the screen it lands on, so only the second is embedded.
  { name: 'sign-up', published: false },
  { name: 'dashboard-first-login', published: true },
  // Step 2 — add a brokerage account.
  { name: 'new-account-dialog', published: true },
  { name: 'accounts-list', published: true },
  // Step 3 — size the trade in the calculator.
  { name: 'calculator', published: true },
  // Steps 4-5 — log a trade through its lifecycle. The list adds nothing the
  // detail view does not, so the guide embeds the worked example alone.
  { name: 'positions-list', published: false },
  { name: 'position-detail', published: true },
  // Step 6 — see it on the dashboard. HELD, but no longer for the original
  // reason: the Stats Summary widget used to photograph blank because it was
  // pinned to a height its own figures could not fit, and that is fixed — its
  // default is now 5 rows, and the tiles measure 124px inside a 133px body.
  // What remains is bookkeeping: publishing the pair means capturing it and
  // adding a <Screenshot name="dashboard"> to the guide's step 6, and
  // `Screenshot.astro` throws at build time for a name with no committed image.
  // So flip this and regenerate in the SAME change, never one without the other.
  { name: 'dashboard', published: false },
  // Step 7 — ask the advisor. HELD: an untouched conversation pane is an empty
  // box, and the step is about credentials rather than a screen.
  { name: 'advisor', published: false },
  // Step 8 — review performance.
  { name: 'performance', published: true },
] as const;
type Surface = (typeof SURFACES)[number]['name'];

const PUBLISHED: ReadonlySet<string> = new Set(
  SURFACES.filter((surface) => surface.published).map((surface) => surface.name),
);

/** A PNG under 4 KB is a blank or half-painted frame, not a screenshot. */
const MIN_IMAGE_BYTES = 4096;

const imagePath = (surface: Surface, theme: Theme): string =>
  path.join(PUBLISHED.has(surface) ? PUBLISHED_DIR : HELD_DIR, `${surface}-${theme}.png`);

/** Milliseconds at which the capture began — every image must post-date it. */
let runStartedAt = 0;

/**
 * Empty both output directories before anything is written. This is the half of
 * the no-stale-image guarantee that a mid-run failure cannot undo: once the old
 * files are gone, a run that dies on surface five cannot leave surfaces six
 * onwards looking current.
 *
 * EVERYTHING GOES, not just `*.png`. These directories exist to hold this
 * spec's output and nothing else, so a leftover of any other kind — a `.jpeg`
 * from a capture that once wrote one, a half-written temp file, a renamed
 * surface's `.webp` — is the same stale artefact the PNG sweep was written to
 * prevent, and outliving the sweep is exactly what made it dangerous. The
 * directory nodes themselves are kept (only their contents are removed) so
 * nothing outside them can be reached, and `verifyManifest` reads the same
 * unfiltered listings back.
 *
 * The held directory is swept for the same reason as the published one, plus
 * one of its own: a surface that flips to `published: true` must not leave its
 * held copy behind for the next reader to mistake for the current image.
 */
function clearOutputDirs(): void {
  for (const dir of [PUBLISHED_DIR, HELD_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  runStartedAt = Date.now();
}

// ---------------------------------------------------------------------------
// The paint gate
// ---------------------------------------------------------------------------

/**
 * WHAT EACH SURFACE MUST ACTUALLY BE SHOWING before it is worth a frame — the
 * positive half of the gate. Each entry is a CSS selector that has to match at
 * least one element, and every match has to have a non-zero laid-out box.
 *
 * These are deliberately the load-bearing bits of the figure rather than a page
 * wrapper: a wrapper is on screen the instant the route mounts, which is the
 * mistake this gate exists to stop making. The dashboard entries name each
 * widget's CONTENT — the stats list, the two chart containers, the balances
 * rows, the calculator form, the open-positions rows — so a widget that dropped
 * to its empty state (the "Close a position to see stats." branch) or that
 * gridstack has not sized yet fails here instead of being photographed.
 */
const PAINTED_WHEN: Record<Surface, readonly string[]> = {
  'sign-up': ['form'],
  'dashboard-first-login': [
    '[data-testid="onboarding-zero-state"]',
    '[data-testid="activation-checklist"]',
  ],
  'new-account-dialog': ['[data-slot="dialog-content"]'],
  'accounts-list': ['[data-testid="demo-banner"]', 'table tbody tr'],
  // Both halves of the calculator, because the figure is both halves. The
  // account picker is named by its ENABLED trigger: while the accounts query is
  // in flight, and again if it fails, the same control renders disabled behind
  // a "Loading accounts…" placeholder, and a frame taken then shows the reader
  // a spinner where their account list belongs. The results panel is named by a
  // card TITLE, which only the sized output carries — the empty, error and
  // zero-position states are a single untitled card holding one line of text,
  // so this is the difference between a computed figure and an excuse.
  calculator: [
    '#entryPrice',
    '[data-tour="calculator-account"] [data-slot="select-trigger"]:not([disabled])',
    '[data-tour="calculator-results"] [data-slot="card-title"]',
  ],
  'positions-list': ['table tbody tr'],
  'position-detail': ['table tbody tr'],
  dashboard: [
    '[data-widget-type="stats-summary"] dl',
    '[data-widget-type="performance-chart"] [data-testid="performance-bar-chart"]',
    '[data-widget-type="account-balances"] ul li',
    '[data-widget-type="equity-curve"] [data-testid="equity-curve-chart"]',
    '[data-widget-type="position-sizing"] form',
    '[data-widget-type="open-positions"] table tbody tr',
  ],
  advisor: ['[data-testid="conversation-pane"]'],
  performance: [
    '[data-testid="equity-curve-chart"]',
    '[data-testid="stats-panel"]',
    '[data-testid="breakdown-table"] table tbody tr',
  ],
};

/**
 * Every chart container in the app. Both mount a Recharts surface, and neither
 * is listed per-surface for the geometry check — `paintFaults` sweeps whatever
 * is on the page, so a chart that appears on a surface nobody thought to list
 * is still held to the same standard.
 */
const CHART_SELECTOR = '[data-testid="equity-curve-chart"], [data-testid="performance-bar-chart"]';

/**
 * How long a surface gets to paint. Generous — this is a generator on a cold
 * stack, not a latency budget — but finite, because the whole point is that a
 * surface which never gets there ends the run instead of being photographed.
 */
const PAINT_TIMEOUT_MS = 20_000;

/**
 * Runs IN THE PAGE. Returns one line per reason this surface is not yet worth a
 * frame, and an empty array when it is — so a timeout reports *what* never
 * arrived rather than merely that something did not.
 *
 * Self-contained by necessity: Playwright serializes this function's source
 * into the page, so it can close over nothing from this module.
 *
 * Three kinds of fault, all of which produce a file that looks fine to the
 * capture and wrong to a reader:
 *
 *  - A skeleton still on screen — a lazily-loaded panel that has not painted.
 *    Kept from the original gate; it is a real signal, just never a sufficient
 *    one on its own.
 *  - Required content missing or laid out at zero. The zero-box case is the one
 *    that bit: a gridstack item exists in the DOM before the grid has given it
 *    a height, and the widget inside it measures nothing at all.
 *  - A chart with no drawn geometry, or drawn against a stale measurement.
 *    Recharts sizes its `<svg>` from a ResizeObserver on the container, so a
 *    surface narrower than the box it lives in is a chart still catching up
 *    with a resize — and `Curve` renders no path at all for an empty series,
 *    which is exactly how the equity curve came out blank.
 *
 * Horizontal overflow rides along here too: it puts the page's own width above
 * the viewport's, and a full-page capture then paints the side drawer's parked
 * off-canvas panel inside the frame, as if a user had opened it.
 */
function paintFaults(input: { chartSelector: string; required: string[] }): string[] {
  const faults: string[] = [];
  const size = (el: Element): DOMRect => el.getBoundingClientRect();

  const root = document.documentElement;
  const overflow = root.scrollWidth - root.clientWidth;
  if (overflow > 0) faults.push(`the page is ${overflow}px wider than the capture viewport`);

  const skeletons = document.querySelectorAll('[data-slot="skeleton"]').length;
  if (skeletons > 0) faults.push(`${skeletons} skeleton(s) still on screen`);

  for (const selector of input.required) {
    const nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length === 0) {
      faults.push(`${selector} — nothing matched`);
      continue;
    }
    for (const node of nodes) {
      const box = size(node);
      if (box.width < 1 || box.height < 1) {
        faults.push(`${selector} — laid out at ${Math.round(box.width)}x${Math.round(box.height)}`);
        break;
      }
    }
  }

  for (const chart of Array.from(document.querySelectorAll(input.chartSelector))) {
    const label = chart.getAttribute('data-testid') ?? 'chart';
    const surface = chart.querySelector('svg.recharts-surface');
    if (!surface) {
      faults.push(`${label} — no chart surface drawn`);
      continue;
    }
    const drawnWidth = size(surface).width;
    const boxWidth = size(chart).width;
    // 2px of slack: Recharts rounds the surface it renders, so an exact
    // comparison would fault on a fractional container width forever.
    if (Math.abs(drawnWidth - boxWidth) > 2) {
      faults.push(
        `${label} — surface is ${Math.round(drawnWidth)}px inside a ${Math.round(boxWidth)}px box`,
      );
      continue;
    }
    const marks = Array.from(
      surface.querySelectorAll<SVGGraphicsElement>('.recharts-line-curve, .recharts-bar-rectangle'),
    );
    const plotted = marks.some((mark) => {
      try {
        return mark.getBBox().width > 0;
      } catch {
        return false;
      }
    });
    if (!plotted) faults.push(`${label} — nothing plotted`);
  }

  return faults;
}

/**
 * Write one image and prove it landed.
 *
 * The gate runs first and RETRIES until the surface is painted or the budget is
 * gone, because every one of its conditions is something the page reaches a
 * moment after the previous assertion passed — a single sample of any of them
 * is a coin toss that fails open. Nothing is captured until the list comes back
 * empty, so a surface that never paints ends the run with no file for it.
 *
 * `page.screenshot` resolving is not the same claim as a usable file existing,
 * so the size and mtime are read back afterwards — the point in the run closest
 * to the write, where the failure still names the surface that caused it.
 */
async function shoot(page: Page, surface: Surface, theme: Theme): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(paintFaults, {
          chartSelector: CHART_SELECTOR,
          required: [...PAINTED_WHEN[surface]],
        }),
      {
        timeout: PAINT_TIMEOUT_MS,
        message: `${surface} (${theme}) never reached a painted state`,
      },
    )
    .toEqual([]);

  const file = imagePath(surface, theme);
  await page.screenshot({
    path: file,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  expect(fs.existsSync(file), `${surface} (${theme}) wrote an image`).toBe(true);
  const stat = fs.statSync(file);
  expect(stat.size, `${surface} (${theme}) image is not a blank frame`).toBeGreaterThan(
    MIN_IMAGE_BYTES,
  );
  expect(stat.mtimeMs, `${surface} (${theme}) image is from this run`).toBeGreaterThanOrEqual(
    runStartedAt,
  );
}

/**
 * The last word on whether the run produced a publishable set. Set equality in
 * both directions, per directory: a missing image is a surface that never got
 * captured, and an unexpected one is a leftover the docs could still be
 * pointing at.
 *
 * BOTH directories are checked, not only the published one. The published check
 * is what stops a held surface reaching the repository — the refresh workflow
 * stages that directory wholesale, so a stray file there is a stray commit. The
 * held check is what stops the split from quietly becoming a way to drop a
 * surface: mark one `published: false` and forget to capture it, and this fails
 * rather than shrugging.
 *
 * The listings are UNFILTERED, matching `clearOutputDirs`. Filtering to `*.png`
 * would let a non-PNG stray sit in the published directory unremarked.
 */
function verifyManifest(): void {
  for (const [dir, label, published] of [
    [PUBLISHED_DIR, 'published', true],
    [HELD_DIR, 'held', false],
  ] as const) {
    const expected = SURFACES.filter((surface) => surface.published === published)
      .flatMap((surface) => THEMES.map((theme) => `${surface.name}-${theme}.png`))
      .sort();
    const actual = fs.readdirSync(dir).sort();
    expect(actual, `every ${label} surface has an image in both themes, and nothing else`).toEqual(
      expected,
    );
  }
}

// ---------------------------------------------------------------------------
// Stack helpers — the idioms the rest of this directory uses
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

function uniqueEmail(): string {
  return `e2e-docs-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login. `/register` is rate-limited per
 * client IP and the harness trusts the loopback proxy, so a forwarded IP is
 * what the limiter keys off. The third octet is this spec's own — 132; every
 * other suite has taken 112-124 and 130/131, and sharing one would put these
 * registrations in another suite's bucket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.132.${ipCounter % 254}`;
}

async function registerUser(req: APIRequestContext): Promise<string> {
  const email = uniqueEmail();
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
}

async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Drive the theme from the sidebar control a user would use, then wait for the
 * class the whole stylesheet keys off before returning, so no capture races the
 * repaint. The preference is stored per browser, so one call holds for the rest
 * of the pass; `assertTheme` below is what proves that rather than assumes it.
 *
 * The class IS the condition — `apps/web/src/index.css` declares no colour
 * transition, and `page.screenshot({ animations: 'disabled' })` fast-forwards
 * any finite one that a component might add later. Nothing here sleeps.
 */
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.getByRole('menuitemradio', { name: theme === 'dark' ? 'Dark' : 'Light' }).click();
  await assertTheme(page, theme);
}

async function assertTheme(page: Page, theme: Theme): Promise<void> {
  if (theme === 'dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  }
}

test.describe('documentation screenshots', () => {
  test.skip(
    // eslint-disable-next-line no-restricted-syntax -- e2e harness flag; no @/lib/config here
    () => !process.env.DOCS_SCREENSHOT_CAPTURE,
    'On-demand docs capture — set DOCS_SCREENSHOT_CAPTURE=1 to run. Not a CI gate.',
  );
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop chromium only — the guide documents the desktop chrome.',
  );

  test('capture every documented surface in light and dark', async ({ page, request }) => {
    // One booted stack, one user, twenty full-page images — far past the
    // default per-test budget, and a generator rather than a gate.
    test.setTimeout(600_000);
    // Wider than the project's default desktop viewport. The positions table is
    // the widest surface the guide shows and it needs about 1390px; below that
    // the page scrolls sideways, which both crops the table and drags the side
    // drawer's parked panel into a full-page frame.
    await page.setViewportSize({ width: 1440, height: 900 });
    clearOutputDirs();

    const email = await registerUser(request);

    // --- Step 1: the sign-up form, before there is a session ----------------
    // Reached from the login page's own link, which is the path the guide
    // describes and the only one that works: a cold load of /register runs the
    // me-query as an anonymous visitor, and the first 401 of a document sends
    // the app to /login.
    //
    // Logged out there is no sidebar and so no theme control, so the preference
    // is written where next-themes keeps it — `localStorage`, per origin rather
    // than per session — and picked up on the next document load. That is the
    // same mechanism the toggle uses, so it captures a real theme rather than a
    // class forced onto <html>.
    await page.goto('/login');
    for (const theme of THEMES) {
      await page.evaluate((value) => window.localStorage.setItem('theme', value), theme);
      await page.goto('/login');
      const signUpLink = page.getByRole('link', { name: 'Register' });
      await expect(signUpLink).toBeVisible();
      await signUpLink.click();
      await expect(page.getByLabel('Confirm password')).toBeVisible();
      await assertTheme(page, theme);
      await shoot(page, 'sign-up', theme);
    }

    await loginViaUi(page, email);

    // --- Steps 1-2, before any account exists -------------------------------
    // What a reader actually meets on first login, and the dialog the guide's
    // "New account" step describes. Both only exist while the user has no
    // accounts, so they are captured before the sample data is seeded.
    for (const theme of THEMES) {
      await page.goto('/dashboard');
      await expect(page.getByTestId('onboarding-zero-state')).toBeVisible();
      await expect(page.getByTestId('activation-checklist')).toBeVisible();
      await setTheme(page, theme);
      await shoot(page, 'dashboard-first-login', theme);

      // The theme control lives behind the dialog's overlay once it is open, so
      // the theme is settled first and the dialog opened second.
      await page.getByTestId('zero-state-create-account').click();
      await expect(page.getByLabel('Name')).toBeVisible();
      await shoot(page, 'new-account-dialog', theme);
      await page.keyboard.press('Escape');
      await expect(page.getByLabel('Name')).toHaveCount(0);
    }

    // --- Seed the sample data ----------------------------------------------
    // Every figure from here on comes from the fixed fourteen-trade fixture, so
    // the images and the prose can quote the same numbers.
    const seeded = await page.request.post('/api/accounts/demo');
    expect(seeded.status(), 'POST /accounts/demo').toBe(201);

    const positions = (await (await page.request.get('/api/positions')).json()) as {
      id: string;
      symbol: string;
      status: string;
    }[];
    expect(positions, 'the fixture is the fourteen-trade set the docs quote').toHaveLength(14);
    const closed = positions.filter((position) => position.status === 'closed');
    expect(closed, 'the fixture has ten closed trades').toHaveLength(10);
    // The guide's worked example is a closed long, so the detail shot is one.
    const detail = closed.find((position) => position.symbol === 'AAPL');
    expect(detail, 'the fixture still contains the closed AAPL trade').toBeDefined();

    // --- Steps 2-6, against the sample data ---------------------------------
    for (const theme of THEMES) {
      await page.goto('/dashboard');
      await expect(page.locator('[data-widget-type]').first()).toBeVisible();
      await setTheme(page, theme);

      await page.goto('/accounts');
      await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
      await expect(page.getByTestId('demo-banner')).toBeVisible();
      await assertTheme(page, theme);
      await shoot(page, 'accounts-list', theme);

      // --- Step 3: the calculator, with the guide's worked example in it -----
      // No seeded state of its own — the arithmetic is a pure function of what
      // is typed, so these four values are the whole fixture and the prose can
      // quote the figures they produce. Deliberately no account selected: an
      // account would cap the size against its cash and the numbers on screen
      // would stop being the ones the arithmetic above gives.
      //
      // Entry and target are the AAPL prices the guide already quotes, so a
      // reader meets the same trade in step 3 and step 5.
      await page.goto('/calculator');
      await expect(page.getByRole('heading', { name: 'Trade Calculator' })).toBeVisible();
      await page.getByLabel('Entry price').fill('182.40');
      await page.getByLabel('Stop loss').fill('178.00');
      await page.getByLabel('Target price (optional)').fill('191.20');
      await page.getByLabel('Dollar risk').fill('500');
      // The form never submits and validates on blur, so the last field has to
      // lose focus before the results exist at all. Filling the earlier fields
      // blurred each of them in turn; this one has nothing after it.
      await page.getByLabel('Dollar risk').blur();
      await expect(page.getByText('Position Sizing')).toBeVisible();
      await shoot(page, 'calculator', theme);

      await page.goto('/positions');
      await expect(page.getByRole('heading', { name: 'Positions' })).toBeVisible();
      await expect(page.locator('table tbody tr')).toHaveCount(14);
      await shoot(page, 'positions-list', theme);

      await page.goto(`/positions/${detail!.id}`);
      await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
      await shoot(page, 'position-detail', theme);

      await page.goto('/dashboard');
      await expect(page.locator('[data-widget-type]').first()).toBeVisible();
      await shoot(page, 'dashboard', theme);

      await page.goto('/advisor');
      await expect(page.getByTestId('conversation-pane')).toBeVisible();
      await shoot(page, 'advisor', theme);

      // Explicit dates rather than the sidebar link's rolling default: the link
      // anchors its window on today, which would move the chart under every
      // regeneration. This window brackets the fixture's own span.
      await page.goto('/performance?granularity=month&start=2026-02-01&end=2026-08-01&tz=UTC');
      await expect(page.getByTestId('performance-page')).toBeVisible();
      await shoot(page, 'performance', theme);
    }

    verifyManifest();
  });
});

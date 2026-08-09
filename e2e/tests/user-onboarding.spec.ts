import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * User-onboarding e2e suite.
 *
 * Everything a newly registered user meets, driven against the booted stack:
 * the zero-state that replaces the six-widget grid, both forks out of it, the
 * guided walkthrough (including the step that refuses to advance on "Next"),
 * what survives an exit and a reload, and the sample-data lifecycle from seed
 * to teardown.
 *
 * ASSERTIONS ARE ON THE DOM AND ON THE NETWORK, NEVER ON REACT STATE. This repo
 * has a documented flake class: a test that reaches for React-internal state
 * across an auth boundary reads it before the tree that owns it has settled and
 * fails intermittently under load. So a walkthrough's position is read off the
 * popover driver.js actually rendered, the checklist's progress off its own
 * text, and the sample account's contents off `GET /api/positions` — all things
 * a user or a proxy could see.
 *
 * STACK REQUIREMENT: the dev stack (web + api + db) must be running.
 * `ensureStackOrSkip` skips the suite rather than failing it when the API is
 * unreachable, matching every other live suite here. This spec is NOT env-gated
 * — it runs in the normal CI e2e job.
 */

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-onboarding-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login. `/register` is rate-limited per
 * client IP (5 / 15 min) and the harness trusts the loopback proxy
 * (`TRUSTED_PROXIES=127.0.0.1` in playwright.config.ts), so a forwarded IP is
 * what the limiter keys off.
 *
 * The third octet is this spec's own — 124. Every other suite's range is taken:
 * 112 admin-platform, 113 advisor-tools, 114 csv-import, 115 wallet-billing,
 * 116 changelog, 117 drawer + hosted-platform, 118 symbol-search-quotes +
 * drawer.mobile, 119 expenses-tax, 120 dashboard, 121 dashboard-event-bus +
 * option-position-entry, 122 dashboard-theme-sync, 123 transactional-email,
 * 130/131 the two visual-design specs. Sharing one would put this suite's
 * registrations in another's bucket and trip 429 intermittently.
 *
 * `process.pid` namespaces the worker, for the same reason it does elsewhere.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.124.${ipCounter % 254}`;
}

/**
 * Register a user and leave them with NO accounts — which is the whole point
 * here. `dashboard.spec.ts`'s helper creates one so its suite lands on the
 * widget grid; this suite is about the screen that stands in for that grid
 * while a user has none, so it must not.
 *
 * The session cookie lands on `req`, so the returned context stays
 * authenticated as this user and can be used for the API-side assertions.
 */
async function registerUser(req: APIRequestContext, label: string): Promise<string> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
}

/** Log in through the form. A unique forwarded IP keeps logins out of one bucket. */
async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Skip gracefully when the API is not up, rather than failing the run. */
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

// ---------------------------------------------------------------------------
// Walkthrough helpers — everything reads the popover driver.js rendered
// ---------------------------------------------------------------------------

const popover = (page: Page): Locator => page.locator('.driver-popover');
const popoverTitle = (page: Page): Locator => page.locator('.driver-popover-title');
const popoverNext = (page: Page): Locator => page.locator('.driver-popover-next-btn');
const popoverProgress = (page: Page): Locator => page.locator('.driver-popover-progress-text');

/**
 * The account set's nine step titles, in order, from
 * `features/onboarding/lib/steps/account.ts`. Walking them by title is what
 * makes "the tour is on step N" an assertion about what the user can read
 * rather than about a number held in a store.
 */
const ACCOUNT_STEP_TITLES = [
  'Start with an account',
  'Name',
  'Currency',
  'Trading-day timezone',
  'Starting balance',
  'Default risk %',
  'Brokerage',
  'Create the account',
  'Your reporting timezone',
] as const;

/** Index of the one step in the account set that is genuinely action-gated. */
const CREATE_STEP = ACCOUNT_STEP_TITLES.indexOf('Create the account');

/**
 * The calculator set's seven step titles, in order, from
 * `features/onboarding/lib/steps/calculator.ts`. It is the only set whose steps
 * all live on one screen and the only item a user with no accounts can complete,
 * which is why both the keyboard traversal and the resume scenario use it.
 */
const CALCULATOR_STEP_TITLES = [
  'Entry price',
  'Stop loss',
  'Target price (optional)',
  'Risk',
  'Account',
  'The amount at risk',
  'Size, risk and R:R',
] as const;

/**
 * Press the walkthrough's entry point once it can actually start one.
 *
 * The control is `aria-disabled` — focusable but inert — until the checklist
 * has landed, and clicking it in that window writes nothing and starts nothing.
 * Waiting for the checklist card is waiting for the same condition the button
 * reads, so this is a wait on the app's own signal rather than on a duration.
 */
async function startWalkthrough(page: Page): Promise<void> {
  await expect(page.getByTestId('activation-checklist')).toBeVisible();
  const button = page.getByTestId('zero-state-walkthrough');
  await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  await button.click();
  await expect(popoverTitle(page)).toHaveText(ACCOUNT_STEP_TITLES[0]);
}

/** Advance with the popover's own button and assert where it landed. */
async function advanceTo(page: Page, index: number): Promise<void> {
  await popoverNext(page).click();
  await expect(popoverTitle(page)).toHaveText(ACCOUNT_STEP_TITLES[index]);
}

/**
 * ONE PRESS, ONE STEP — pressed once, asserted once, with no retry.
 *
 * This used to press in a `toPass` loop, and the loop was hiding a real defect:
 * driver.js drops an arrow press while a step transition is running, which is
 * for 400ms after the last one and for the whole of the tour's opening
 * highlight, so the first press per transition never landed. `tour-engine.ts`
 * now owns the arrow keys itself (`allowKeyboardControl: false`) and routes them
 * through the same functions the popover's buttons use, so a press is never
 * swallowed.
 *
 * Naming the exact neighbouring title is what makes this an EXACTLY-one-step
 * assertion rather than an at-least-one-step one: a press that moved two steps
 * lands somewhere else and fails here just as a dropped press does.
 */
async function pressToTitle(page: Page, key: string, expected: string): Promise<void> {
  await page.keyboard.press(key);
  await expect(popoverTitle(page)).toHaveText(expected);
}

/**
 * THE POPOVER MUST NOT LIE ACROSS THE CONTROL ITS OWN STEP IS FINISHED BY, and
 * a click cannot always tell you that it does.
 *
 * Playwright hit-tests the CENTRE of the box it is about to click, so a popover
 * that covers a control's edge — but stops short of its middle — dispatches
 * cleanly and the suite goes green over an overlap a user can see and can land
 * a pointer in. That is exactly the state the two fill-dialog steps shipped in:
 * the popover sat 21px across the Add button's right-hand end while its centre
 * stayed 9px clear, so every real click here passed.
 *
 * Measuring the rectangles is what closes that gap. It fails on any intersection
 * at all rather than on the one that happens to swallow a click, and it reports
 * the overlap in pixels so the next person does not have to re-measure it.
 */
async function expectClearOfPopover(page: Page, control: Locator, what: string): Promise<void> {
  const pop = await popover(page).boundingBox();
  const box = await control.boundingBox();
  if (pop === null || box === null) {
    throw new Error(`${what}: the popover and the control must both be on screen to be measured`);
  }
  const dx = Math.min(pop.x + pop.width, box.x + box.width) - Math.max(pop.x, box.x);
  const dy = Math.min(pop.y + pop.height, box.y + box.height) - Math.max(pop.y, box.y);
  expect(
    dx > 0 && dy > 0,
    `the walkthrough popover overlaps ${what} by ${dx.toFixed(0)}x${dy.toFixed(0)}px ` +
      `(popover x ${pop.x.toFixed(0)}–${(pop.x + pop.width).toFixed(0)}, ` +
      `y ${pop.y.toFixed(0)}–${(pop.y + pop.height).toFixed(0)}; ` +
      `control x ${box.x.toFixed(0)}–${(box.x + box.width).toFixed(0)}, ` +
      `y ${box.y.toFixed(0)}–${(box.y + box.height).toFixed(0)})`,
  ).toBe(false);
}

/** Escape out of the tour — also one press, for the same reason. */
async function escapeTour(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

/**
 * Tab forward until `selector` holds focus. Failing this is the assertion that
 * a control is missing from the tab order, which is the whole reason the
 * onboarding surfaces use `aria-disabled` rather than `disabled`.
 */
async function tabTo(page: Page, selector: string): Promise<void> {
  const isFocused = (): Promise<boolean> =>
    page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
  for (let press = 0; press < 60; press += 1) {
    if (await isFocused()) return;
    await page.keyboard.press('Tab');
  }
  expect(await isFocused(), `${selector} is reachable by Tab`).toBe(true);
}

/**
 * Walk the account set from its first step to `stopAt`, opening the account
 * dialog on the way because the six field steps anchor to controls that only
 * exist once it is open.
 */
async function walkAccountSetTo(page: Page, stopAt: number): Promise<void> {
  await page.getByTestId('zero-state-create-account').click();
  await expect(page.getByLabel('Name')).toBeVisible();
  for (let index = 1; index <= stopAt; index += 1) {
    await advanceTo(page, index);
  }
}

/** Fill the account form and submit it — the real action the gated step waits for. */
async function createAccountFromDialog(page: Page, name: string): Promise<void> {
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
}

/** The checklist's own progress line, wherever the checklist is mounted. */
const checklistProgress = (page: Page): Locator =>
  page.getByTestId('activation-checklist-progress');

/**
 * One checklist item's LABEL — the span carrying its name and the screen-reader
 * completion text, not the whole row.
 *
 * The row also holds the per-item "Start" button, which renders for an item that
 * is outstanding and has a walkthrough behind it. Reading the row would put that
 * label after the completion text and defeat the `$` anchor the assertions below
 * are made of, for a reason that has nothing to do with completion.
 */
const checklistItemLabel = (page: Page, id: string): Locator =>
  page.locator(`[data-checklist-item="${id}"] > span`).first();

/**
 * The position set's five step titles, in order, from
 * `features/onboarding/lib/steps/position.ts`. It is the only set that changes
 * screen onto a row the user creates while the tour is running.
 */
const POSITION_STEP_TITLES = [
  'Log the position',
  'Symbol, side and account',
  'It starts as a draft',
  'Open the position',
  'That is a position logged',
] as const;

/**
 * One labelled control inside a dialog, by the label above it.
 *
 * These are Radix selects, so the label is a sibling with no `htmlFor` and the
 * trigger has no accessible name of its own — `getByLabel` cannot see them, and
 * an index into "every combobox in the dialog" would silently move the moment a
 * field is added. The label text is what the step copy names, so it is what the
 * test asks for.
 */
function dialogSelect(dialog: Locator, label: string): Locator {
  return dialog.locator(`div:has(> label:text-is("${label}")) > button[role="combobox"]`);
}

/**
 * The close set's three step titles, in order, from
 * `features/onboarding/lib/steps/close.ts`.
 */
const CLOSE_STEP_TITLES = ['Record the exit', 'It closes itself', 'And there it is'] as const;

/** An account, over the API — this suite's own guided path already covers the UI one. */
async function createAccount(req: APIRequestContext, name: string): Promise<string> {
  const res = await req.post('/api/accounts', {
    data: { name, currency: 'USD' },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `POST /accounts ${name}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A position the user has open with one entry fill — the state checklist item 4
 * is about, and the only state its walkthrough makes sense in.
 *
 * The entry fill MUST precede `/open`: the API refuses to open a position that
 * has none.
 */
async function createOpenPosition(req: APIRequestContext, accountId: string): Promise<string> {
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' },
  });
  expect(posRes.status(), 'POST /positions').toBe(201);
  const positionId = ((await posRes.json()) as { id: string }).id;

  const entryRes = await req.post(`/api/positions/${positionId}/fills`, {
    data: { type: 'entry', price: '150.00', quantity: '10', fees: '0', filledAt: OPENED_AT },
  });
  expect(entryRes.status(), 'POST entry fill').toBe(201);

  const openRes = await req.post(`/api/positions/${positionId}/open`, {
    data: { openedAt: OPENED_AT },
  });
  expect(openRes.status(), 'POST /open').toBe(200);
  return positionId;
}

const OPENED_AT = '2026-05-01T14:30:00.000Z';

test.describe('user onboarding', () => {
  // Desktop only. The walkthrough overlay, the account dialog and the sample
  // data banner are all exercised here at a width where they coexist; the
  // mobile project re-runs every non-ignored spec, and a second full pass of
  // this one buys no coverage the responsive assertions elsewhere do not
  // already carry.
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile);

  test.beforeEach(async ({ request }) => {
    await ensureStackOrSkip(request);
  });

  test('a new user lands on the zero-state, not six empty widgets', async ({ page, request }) => {
    const email = await registerUser(request, 'zero');
    await loginViaUi(page, email);

    await expect(page.getByTestId('onboarding-zero-state')).toBeVisible();
    // The screen this replaces: no widget renders, and neither does the grid
    // container that would hold them.
    await expect(page.locator('[data-widget-type]')).toHaveCount(0);
    await expect(page.locator('[data-grid-mode]')).toHaveCount(0);

    // The statement the whole screen exists to make.
    await expect(page.getByTestId('zero-state-not-connected')).toContainText(
      'not connected to your broker',
    );
    await expect(checklistProgress(page)).toHaveText('0 of 4 complete');
  });

  test('the guided path creates the account, and its action step ignores Next', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'guided');
    await loginViaUi(page, email);
    await startWalkthrough(page);

    const gatedStep = `${CREATE_STEP + 1} of ${ACCOUNT_STEP_TITLES.length}`;
    await walkAccountSetTo(page, CREATE_STEP);
    await expect(popoverProgress(page)).toHaveText(gatedStep);

    // THE GATE. This step's action — the account actually being created — is one
    // the app publishes an event for, so the step is genuinely held: pressing
    // "Next" must leave the tour exactly where it is. Pressed twice, because a
    // single press racing an advance would pass either way.
    await popoverNext(page).click();
    await popoverNext(page).click();
    await expect(popoverTitle(page)).toHaveText('Create the account');
    await expect(popoverProgress(page)).toHaveText(gatedStep);

    // Doing the thing is what advances it.
    await createAccountFromDialog(page, 'Guided account');
    await expect(popoverTitle(page)).toHaveText(ACCOUNT_STEP_TITLES[CREATE_STEP + 1]);

    // Finish. The dashboard behind the tour has already swapped to the grid.
    await popoverNext(page).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.getByTestId('onboarding-zero-state')).toHaveCount(0);
    await expect(page.locator('[data-widget-type]').first()).toBeVisible();

    // Item 1 ticked itself off the user's real data, no flag written.
    await expect(checklistProgress(page)).toHaveText('1 of 4 complete');
    await expect(checklistItemLabel(page, 'account')).toHaveText(/— completed$/);
  });

  // A TARGET THE USER HAS NOT MADE YET IS WAITED FOR, NOT GIVEN UP ON.
  //
  // The first step asks the user to open the account dialog, and that gesture
  // publishes nothing the walkthrough can hear, so "Next" is what drives it.
  // Pressing Next before opening the dialog is therefore the ordinary thing to
  // do — the step names a button, not a Next — and it asks for `#name`, a field
  // that does not exist yet. The wait behind that step used to be sized for a
  // dialog already opening, so it expired while the user was still reading and
  // ended the walkthrough on a field that was about to appear.
  //
  // The five-second pause is the assertion: it is longer than any render this
  // screen does, so a tour still up after it is one that is genuinely waiting.
  test('a step waits for a target the user has not created yet', async ({ page, request }) => {
    const email = await registerUser(request, 'waitfor');
    await loginViaUi(page, email);
    await startWalkthrough(page);

    await popoverNext(page).click();
    await expect(popover(page)).toHaveCount(1);
    await page.waitForTimeout(5_000);
    await expect(popover(page)).toHaveCount(1);
    // Still on the step that asked, because the tour has not moved — it is
    // holding the window open for the control the next step needs.
    await expect(popoverTitle(page)).toHaveText(ACCOUNT_STEP_TITLES[0]);

    // And the moment the user does the thing, the tour is there.
    await page.getByTestId('zero-state-create-account').click();
    await expect(popoverTitle(page)).toHaveText(ACCOUNT_STEP_TITLES[1]);
    await escapeTour(page);
  });

  // THE POSITION SET, END TO END — the set this suite never drove, which is how
  // it shipped unfinishable. Creating the position leaves the user on
  // `/positions` while step 3 lives on `/positions/$positionId`, so the target
  // never appeared, the tour exited without a word, and the draft → open →
  // closed lifecycle the set exists to teach was unreachable.
  //
  // Every control is operated with a REAL CLICK, never `force` and never the
  // keyboard. That is the other half of this test: step 2 describes Symbol,
  // Side, Asset Type and Account and waits for all four to be filled in, and its
  // popover used to sit on top of the last three at 1280x720 — Playwright
  // hit-tests before it dispatches, so an intercepted control fails here and
  // passes any assertion made in jsdom, which has no layout to hit-test against.
  test('the position set runs through draft and open to its last step', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'positionset');
    await createAccount(request, 'Position account');
    await loginViaUi(page, email);
    await expect(page.getByTestId('activation-checklist')).toBeVisible();

    await page.locator('[data-checklist-action="position"]').click();
    await expect(page).toHaveURL(/\/positions$/);
    await expect(popoverTitle(page)).toHaveText(POSITION_STEP_TITLES[0]);

    // The gesture step 1 asks for, from the control it highlights.
    await page.locator('[data-tour="position-new"]').click();
    const dialog = page.getByRole('dialog', { name: 'New Position' });
    await expect(dialog.locator('#symbol')).toBeVisible();
    await popoverNext(page).click();
    await expect(popoverTitle(page)).toHaveText(POSITION_STEP_TITLES[1]);

    // The three controls the popover covered. Each click is the assertion.
    await dialogSelect(dialog, 'Side').click({ timeout: 5_000 });
    await page.getByRole('option', { name: 'Long' }).click();
    await dialogSelect(dialog, 'Asset Type').click({ timeout: 5_000 });
    await page.getByRole('option', { name: 'Stock' }).click();
    await dialogSelect(dialog, 'Account').click({ timeout: 5_000 });
    await page.getByRole('option', { name: 'Position account (USD)' }).click();
    await dialog.locator('#symbol').click();
    await dialog.locator('#symbol').fill('AAPL');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    // THE ASSERTION THIS TEST EXISTS FOR. The tour follows the position onto its
    // own page, which nothing but the walkthrough was going to do.
    await expect(popoverTitle(page)).toHaveText(POSITION_STEP_TITLES[2]);
    await expect(page).toHaveURL(/\/positions\/[0-9a-f-]{36}/);

    // Draft → open, through the two controls the remaining steps highlight.
    await page.locator('[data-tour="position-add-fill"]').click();
    await expect(page.getByLabel('Price')).toBeVisible();
    // The step highlights Add Fill, but what FINISHES it is the Add button in
    // the dialog Add Fill opens, so that is the control the popover has to keep
    // out of the way of.
    await expectClearOfPopover(
      page,
      page.getByRole('button', { name: 'Add', exact: true }),
      "the fill dialog's Add button, on 'It starts as a draft'",
    );
    await page.locator('#price').fill('150.00');
    await page.locator('#quantity').fill('10');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(popoverTitle(page)).toHaveText(POSITION_STEP_TITLES[3]);

    await page.locator('[data-tour="position-open"]').click();
    await expect(popoverTitle(page)).toHaveText(POSITION_STEP_TITLES[4]);
    await expect(popoverProgress(page)).toHaveText(`5 of ${POSITION_STEP_TITLES.length}`);

    // "Done" finishes it, and item 3 ticks off the user's real data. The set
    // ends on the position rather than the dashboard, so the checklist is read
    // where it lives.
    await popoverNext(page).click();
    await expect(popover(page)).toHaveCount(0);
    await page.goto('/dashboard');
    await expect(checklistProgress(page)).toHaveText('2 of 4 complete');
    await expect(checklistItemLabel(page, 'position')).toHaveText(/— completed$/);
    const logged = (await (await request.get('/api/positions')).json()) as { status: string }[];
    expect(logged.map((position) => position.status)).toEqual(['open']);
  });

  // A COMPLETE RUN OF THE SET THAT ENDS THE WALKTHROUGH, and the reason this
  // suite needed one: every scenario above stops partway, so the thing item 4
  // exists to show — the dashboard with the user's own figures in it — was
  // never reached by a test, and was not reachable by a user either.
  //
  // The trade closes ITSELF here. Nobody presses "Close Position": an exit that
  // balances the entered quantity closes the position in the same transaction
  // that records the fill, so the control the middle step highlights is gone by
  // the time the tour has finished with it. Without the response saying the
  // close happened, no 'closed' event is published, the tour sits on that step
  // waiting for a signal that will never come, and the last step is unreachable.
  test('the close set runs through to the now-populated dashboard', async ({ page, request }) => {
    const email = await registerUser(request, 'closeset');
    const accountId = await createAccount(request, 'Close account');
    const positionId = await createOpenPosition(request, accountId);

    await loginViaUi(page, email);
    // An account and a logged position, both derived from the data — so the two
    // outstanding items are the calculator and this one.
    await expect(checklistProgress(page)).toHaveText('2 of 4 complete');

    await page.locator('[data-checklist-action="close"]').click();

    // It opens on the position the user has open, which nobody told it: the
    // checklist names the ITEM, never the row.
    await expect(page).toHaveURL(new RegExp(`/positions/${positionId}`));
    await expect(popoverTitle(page)).toHaveText(CLOSE_STEP_TITLES[0]);

    // The exit, recorded from the control this step highlights.
    await page.locator('[data-tour="position-add-fill"]').click();
    await expect(page.getByLabel('Price')).toBeVisible();
    // Same control, same dialog, same step shape as the position set's draft
    // step — and it shipped with the same overlap, so it is measured here too.
    await expectClearOfPopover(
      page,
      page.getByRole('button', { name: 'Add', exact: true }),
      "the fill dialog's Add button, on 'Record the exit'",
    );
    await page.getByRole('dialog').getByRole('combobox').click();
    await page.getByRole('option', { name: 'Exit' }).click();
    await page.locator('#price').fill('160.00');
    await page.locator('#quantity').fill('10');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // THE ASSERTION. The tour follows the position closing itself all the way to
    // its last step, on the dashboard, with the widgets it was pointing at.
    await expect(popoverTitle(page)).toHaveText(CLOSE_STEP_TITLES[2]);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator('[data-grid-mode]')).toBeVisible();
    // And it got there without anyone closing anything by hand — that button
    // renders only while a position is open, and this one is not.
    await expect(page.locator('[data-tour="position-close"]')).toHaveCount(0);

    // "Done" finishes it, and item 4 ticks off the user's real data.
    await popoverNext(page).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(checklistProgress(page)).toHaveText('3 of 4 complete');
    await expect(checklistItemLabel(page, 'close')).toHaveText(/— completed$/);
    const closed = (await (await request.get('/api/positions')).json()) as { status: string }[];
    expect(closed.map((position) => position.status)).toEqual(['closed']);
  });

  // THE OTHER WAY OUT OF THE SAME SET, and the one its first step invites in so
  // many words: "Partial exits are ordinary". A partial exit does not close the
  // position, so the middle step's `closed` signal never arrives and the Close
  // Position it highlights stays disabled ("Exit the full quantity first") —
  // which used to leave the user on a live overlay with a control they could not
  // press, no "Next", and nothing but Escape, which ends the walkthrough.
  test('a partial exit carries on through the close set instead of trapping', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'partialexit');
    const accountId = await createAccount(request, 'Partial account');
    const positionId = await createOpenPosition(request, accountId);

    await loginViaUi(page, email);
    await page.locator('[data-checklist-action="close"]').click();
    await expect(page).toHaveURL(new RegExp(`/positions/${positionId}`));
    await expect(popoverTitle(page)).toHaveText(CLOSE_STEP_TITLES[0]);

    // Half of the ten units entered — a real exit, and not the last one.
    await page.locator('[data-tour="position-add-fill"]').click();
    await expect(page.getByLabel('Price')).toBeVisible();
    await page.getByRole('dialog').getByRole('combobox').click();
    await page.getByRole('option', { name: 'Exit' }).click();
    await page.locator('#price').fill('160.00');
    await page.locator('#quantity').fill('5');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // The fill is real, so the tour moves — onto the step whose control this
    // exit leaves unpressable.
    await expect(popoverTitle(page)).toHaveText(CLOSE_STEP_TITLES[1]);
    await expect(page.locator('[data-tour="position-close"]')).toBeDisabled();

    // THE ASSERTION. "Next" is live, because the gate behind it cannot be
    // opened — and it carries the user to the last step, on the dashboard,
    // exactly as the full exit does.
    await popoverNext(page).click();
    await expect(popoverTitle(page)).toHaveText(CLOSE_STEP_TITLES[2]);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator('[data-grid-mode]')).toBeVisible();

    await popoverNext(page).click();
    await expect(popover(page)).toHaveCount(0);

    // And nothing closed the position to get there: item 4 is honestly still
    // outstanding, because the trade is.
    const after = (await (await request.get('/api/positions')).json()) as { status: string }[];
    expect(after.map((position) => position.status)).toEqual(['open']);
    await expect(checklistItemLabel(page, 'close')).not.toHaveText(/— completed$/);
  });

  // THE TOUR'S STYLESHEET OUTLIVES THE TOUR. It arrives with the engine chunk
  // and nothing unloads it, so its rules go on applying for the rest of the
  // session — including the ones that hand `pointer-events` back to everything a
  // dialog did not hide, which exist so the tour cannot block a dialog it told
  // the user to open. Unscoped, those outrank `disabled:pointer-events-none` and
  // leave every disabled control in every ordinary dialog clickable to a user
  // whose only crime was running the walkthrough once.
  //
  // ONE PAGE, NO RELOAD, DELIBERATELY: a reload drops the dynamically imported
  // engine chunk and its stylesheet with it, which would make this pass for a
  // reason that has nothing to do with the scoping under test.
  test('a disabled control in an ordinary dialog is still inert after a tour', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'cssrelease');
    const accountId = await createAccount(request, 'Leak account');
    const positionId = await createOpenPosition(request, accountId);

    await loginViaUi(page, email);
    await page.locator('[data-checklist-action="close"]').click();
    await expect(page).toHaveURL(new RegExp(`/positions/${positionId}`));
    await expect(popoverTitle(page)).toHaveText(CLOSE_STEP_TITLES[0]);

    // DURING the tour, the release still does the job it was added for. Clicking
    // is the proof, not typing: Playwright hit-tests a click against whatever is
    // actually on top, so a field left under the overlay fails here.
    await page.locator('[data-tour="position-add-fill"]').click();
    await expect(page.getByLabel('Price')).toBeVisible();
    await page.locator('#price').click();
    await page.locator('#price').fill('160.00');
    await expect(page.locator('#price')).toHaveValue('160.00');

    // Out of the dialog and out of the tour, into an ordinary session — with the
    // stylesheet still loaded, because nothing unloads it.
    await page.keyboard.press('Escape');
    await escapeTour(page);
    await expect(page.locator('body.driver-active')).toHaveCount(0);

    // Close the position from the app itself, so the page never reloads.
    await page.locator('[data-tour="position-add-fill"]').click();
    await page.getByRole('dialog').getByRole('combobox').click();
    await page.getByRole('option', { name: 'Exit' }).click();
    await page.locator('#price').fill('160.00');
    await page.locator('#quantity').fill('10');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('[data-tour="position-close"]')).toHaveCount(0);

    // An ordinary dialog with a genuinely disabled control in it: editing a fill
    // on a CLOSED position cannot change its quantity.
    await page.locator('table [aria-haspopup="menu"]').first().click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const quantity = page.locator('#quantity');
    await expect(quantity).toBeDisabled();

    // THE ASSERTION, on the property the leak actually broke. `toBeDisabled`
    // reads the DOM and would pass either way; this reads what the cascade
    // resolved to, which is what decides whether a pointer can reach it.
    await expect(quantity).toHaveCSS('pointer-events', 'none');
  });

  test('exiting mid-walkthrough keeps the work already done', async ({ page, request }) => {
    const email = await registerUser(request, 'exit');
    await loginViaUi(page, email);
    await startWalkthrough(page);

    // Real work, done inside the tour: only the highlighted control is
    // interactive while the overlay is up, so the account has to be created from
    // the step that highlights the submit button. It exists from here on and
    // nothing the tour does may take it away.
    await walkAccountSetTo(page, CREATE_STEP);
    await createAccountFromDialog(page, 'Exit account');
    await expect(popoverTitle(page)).toHaveText(ACCOUNT_STEP_TITLES[CREATE_STEP + 1]);
    await expect(page.getByTestId('onboarding-zero-state')).toHaveCount(0);

    // Escape — one action, and the tour is abandoned rather than completed.
    await escapeTour(page);

    await expect(checklistProgress(page)).toHaveText('1 of 4 complete');
    // And it is on the server, not just on the screen.
    const accounts = (await (await request.get('/api/accounts')).json()) as { name: string }[];
    expect(accounts.map((account) => account.name)).toEqual(['Exit account']);

    await page.reload();
    await expect(page.locator('[data-widget-type]').first()).toBeVisible();
    await expect(checklistProgress(page)).toHaveText('1 of 4 complete');
  });

  test('a reload mid-walkthrough resumes from what the data says is outstanding', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'resume');
    await loginViaUi(page, email);
    await expect(page.getByTestId('activation-checklist')).toBeVisible();

    // Start a set OTHER than the first, off the checklist, so "where the user
    // was" and "what the data says is outstanding" are different answers.
    await page.locator('[data-checklist-action="calculator"]').click();
    await expect(page).toHaveURL(/\/calculator/);
    await expect(popoverTitle(page)).toHaveText(CALCULATOR_STEP_TITLES[0]);

    // AND FINISH THAT ITEM BEFORE THE RELOAD, INSIDE THE TOUR. A user at 0 of 4
    // cannot tell resume apart from a restart: with nothing ticked, "the first
    // outstanding item" and "the first item" are the same step, so the tour
    // landing on it proves nothing about where the answer came from. So the
    // calculator is really used here — the three figures a size needs, typed
    // into the controls each step highlights. It is the one item completable
    // without an account, and item 2's only trace is the stored first-use
    // timestamp the calculation writes.
    await page.locator('#entryPrice').fill('100');
    for (const title of CALCULATOR_STEP_TITLES.slice(1)) {
      await popoverNext(page).click();
      await expect(popoverTitle(page)).toHaveText(title);
      if (title === 'Stop loss') await page.locator('#stopLoss').fill('95');
      if (title === 'The amount at risk') await page.locator('#dollarRisk').fill('50');
    }
    // The results appearing IS the successful calculation the write hangs off.
    // They arrive on the LAST field leaving focus, because the form validates on
    // blur, which is what the move to the results step does.
    await expect(
      page
        .locator('[data-tour="calculator-results"]')
        .getByText('Position Sizing', { exact: true }),
    ).toBeVisible();

    await page.reload();
    // Nothing auto-starts, so the reload leaves no tour running at all.
    await expect(page.locator('#entryPrice')).toBeVisible();
    await expect(popover(page)).toHaveCount(0);

    // The item is ticked off the user's data, and its own shortcut goes with it
    // — nothing here is a stored per-step flag.
    await page.goto('/dashboard');
    await expect(checklistProgress(page)).toHaveText('1 of 4 complete');
    await expect(checklistItemLabel(page, 'calculator')).toHaveText(/— completed$/);
    await expect(page.locator('[data-checklist-action="calculator"]')).toHaveCount(0);

    // Re-entering resumes by re-deriving the outstanding item from the user's
    // data — no step index was ever stored, so it lands on the account set,
    // which is what the checklist still says is outstanding. NOT the calculator
    // set the user was in when they reloaded, and not the one they just
    // completed.
    //
    // THE ACCOUNT SET IS AS FAR AS THIS CAN GO, and the reason is a property of
    // the product rather than of the test: every way into a walkthrough lives on
    // the zero-state, the zero-state renders only while the user has no
    // accounts, and having no accounts is exactly what leaves item 1
    // outstanding. So the first outstanding item is ALWAYS item 1 wherever the
    // entry point exists, and resuming onto a later set — the calculator set,
    // after an account is created — is unreachable from the UI as it stands.
    await startWalkthrough(page);
    await expect(popoverProgress(page)).toHaveText(`1 of ${ACCOUNT_STEP_TITLES.length}`);

    await escapeTour(page);
    await expect(checklistProgress(page)).toHaveText('1 of 4 complete');
  });

  test('the unguided path leaves a usable checklist behind', async ({ page, request }) => {
    const email = await registerUser(request, 'unguided');
    await loginViaUi(page, email);

    // Both of the zero-state's fallbacks are there before any choice is made.
    await expect(page.getByTestId('activation-checklist')).toBeVisible();
    for (const label of [
      'Create a brokerage account',
      'Size a trade in the calculator',
      'Log a position',
      'Close it and see the stats',
    ]) {
      await expect(page.getByText(label, { exact: false })).toBeVisible();
    }
    const docsLink = page.getByTestId('zero-state-docs-link');
    await expect(docsLink).toHaveAttribute('href', /docs\.tradr\.cloud/);
    await expect(docsLink).toHaveAttribute('target', '_blank');

    // Take the unguided fork: create the account directly, no tour anywhere.
    await page.getByTestId('zero-state-create-account').click();
    await createAccountFromDialog(page, 'Unguided account');
    await expect(popover(page)).toHaveCount(0);

    // The checklist follows the user off the zero-state, ticked by what they
    // actually did and still naming the three items left.
    await expect(checklistProgress(page)).toHaveText('1 of 4 complete');
    await expect(checklistItemLabel(page, 'account')).toHaveText(/— completed$/);
    await expect(checklistItemLabel(page, 'calculator')).toHaveText(/— not completed$/);
  });

  test('sample data banners app-wide, completes nothing, and tears down clean', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'demo');
    await loginViaUi(page, email);
    await expect(page.getByTestId('activation-checklist')).toBeVisible();

    await page.getByTestId('zero-state-sample-data').click();
    // The seed drives fourteen trades through the real position lifecycle in
    // one transaction, so it is the slowest write in the product.
    await expect(page.getByTestId('demo-banner')).toBeVisible({ timeout: 30_000 });

    // Seeding is not creating an account: item 1 stays open and the checklist
    // stays on screen with every item still to do.
    await expect(checklistProgress(page)).toHaveText('0 of 4 complete');
    await expect(checklistItemLabel(page, 'account')).toHaveText(/— not completed$/);

    // App-wide, not dashboard-only — every derived surface carries the notice,
    // because the banner is mounted in the authenticated layout rather than on
    // one page. (`/performance` is left out on purpose: its route validates
    // required search params, so a bare navigation there is a router error on
    // any account, sample data or not.)
    for (const route of ['/positions', '/accounting', '/accounts']) {
      await page.goto(route);
      await expect(page.getByTestId('demo-banner')).toBeVisible();
    }

    // The fixture is written out in full, so its figures are assertable.
    await page.goto('/positions');
    await expect(page.locator('table tbody tr')).toHaveCount(14);
    const seeded = (await (await request.get('/api/positions')).json()) as { status: string }[];
    expect(seeded).toHaveLength(14);
    expect(seeded.filter((position) => position.status === 'closed')).toHaveLength(10);

    // One click, from the notice itself.
    await page.getByTestId('demo-banner-remove').click();
    await expect(page.getByTestId('demo-banner')).toHaveCount(0);
    await expect(page.getByText('No positions found.')).toBeVisible();

    // Nothing left behind: the user is back to having no accounts at all, which
    // is the state the zero-state is for.
    await page.goto('/dashboard');
    await expect(page.getByTestId('onboarding-zero-state')).toBeVisible();
    const emptied = (await (await request.get('/api/positions')).json()) as unknown[];
    expect(emptied).toHaveLength(0);
    const accounts = (await (await request.get('/api/accounts')).json()) as unknown[];
    expect(accounts).toHaveLength(0);
  });

  // A COACH MARK MUST NOT BLOCK THE SURFACE IT DESCRIBES, and this is the half
  // of that no unit test can hold. `CoachMark.test.tsx` asserts non-blocking in
  // jsdom, where nothing has a position or a size — so its click reached the
  // surface whether or not an opaque popover was sitting on top of it, and the
  // assertion passed while the import page shipped with its mark covering the
  // account picker. Playwright's actionability check is the thing that can
  // tell: it hit-tests the point it is about to click and refuses to dispatch
  // when something else would receive the event.
  //
  // The import surface is the case that broke, so it is the case pinned here:
  // the mark opens below the page heading, and step 1's combobox is directly
  // under it.
  test('a coach mark does not stand between the user and the control it describes', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'coachmark');
    // The picker needs something to pick, and the mark needs the surface to be
    // usable — it is gated on the plan having imports left.
    const created = await request.post('/api/accounts', {
      data: { name: 'Coach Mark Acct', currency: 'USD' },
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(created.status(), 'seed account').toBe(201);
    await loginViaUi(page, email);

    await page.goto('/import');
    const coachMark = page.getByTestId('coach-mark-csv-import');
    await expect(coachMark).toBeVisible();

    // THE CLICK IS THE ASSERTION. With the popover in the pointer path this
    // times out with "subtree intercepts pointer events" — the exact failure
    // that took the whole csv-import suite down.
    const picker = page.getByRole('combobox', { name: 'Target account' });
    await picker.click({ timeout: 5_000 });
    await expect(page.getByRole('option', { name: 'Coach Mark Acct (USD)' })).toBeVisible();

    // And the same gesture dismissed the mark: reaching past it is an outside
    // press, which is a dismissal like any other close.
    await expect(coachMark).toHaveCount(0);
  });

  test('the walkthrough is reachable and traversable with the keyboard alone', async ({
    page,
    request,
  }) => {
    const email = await registerUser(request, 'keyboard');
    await loginViaUi(page, email);
    await expect(page.getByTestId('activation-checklist')).toBeVisible();

    // The guided control must be IN the tab order. It is `aria-disabled` rather
    // than `disabled` precisely so a keyboard user meets it, so reaching it with
    // Tab is the assertion.
    await tabTo(page, '[data-testid="zero-state-walkthrough"]');
    await page.keyboard.press('Enter');
    await expect(popoverTitle(page)).toHaveText(ACCOUNT_STEP_TITLES[0]);

    // Escape ends it in one key, from any step.
    await escapeTour(page);

    // And a set whose steps all live on one screen traverses on the arrow keys
    // alone — the account set cannot, because its field steps need a dialog the
    // user opens by activating the highlighted control.
    await tabTo(page, '[data-checklist-action="calculator"]');
    await page.keyboard.press('Enter');
    await expect(popoverTitle(page)).toHaveText(CALCULATOR_STEP_TITLES[0]);
    // Consecutive presses, each asserted on its own: this is where a dropped
    // press shows up, because every press after the first follows a transition
    // that has only just painted the title the one before it produced.
    await pressToTitle(page, 'ArrowRight', CALCULATOR_STEP_TITLES[1]);
    await pressToTitle(page, 'ArrowRight', CALCULATOR_STEP_TITLES[2]);
    await pressToTitle(page, 'ArrowLeft', CALCULATOR_STEP_TITLES[1]);
    await pressToTitle(page, 'ArrowLeft', CALCULATOR_STEP_TITLES[0]);
    // The first step is the front of the set, and the key that would run off it
    // does nothing rather than ending the tour.
    await page.keyboard.press('ArrowLeft');
    await expect(popoverTitle(page)).toHaveText(CALCULATOR_STEP_TITLES[0]);
    await escapeTour(page);
  });
});

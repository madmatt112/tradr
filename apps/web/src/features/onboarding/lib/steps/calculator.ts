/**
 * Checklist item 2 — size a trade in the calculator.
 *
 * Runs on `/calculator`, which `routes/_auth.calculator.tsx` mounts.
 *
 * EVERY CLAIM, AND WHERE IT WAS CHECKED (`CalculatorForm.tsx`,
 * `CalculatorResults.tsx`, `packages/shared/src/calculator.ts`):
 * - The form has no submit and recomputes from the watched values on every
 *   render; `calculateTrade` runs client-side.
 * - Entry price, Stop loss and Target price (optional) are the labels, and
 *   `#entryPrice`, `#stopLoss`, `#targetPrice` the ids.
 * - Risk is a two-tab choice, Dollar or Percent, and Percent is the ONLY basis
 *   in which the account's rule is read: `#balance` and `#riskPercent` are not
 *   rendered at all under the Dollar tab, which is the default. That is why the
 *   risk step comes before the account step and why the amount step waits for
 *   its target rather than assuming it.
 * - THE USER CHOOSES THE BASIS, so the amount step has to survive either
 *   choice. The step below invites Percent but cannot compel it, and a step
 *   anchored to `#riskPercent` alone would exit `target-missing` the moment
 *   someone stayed on Dollar. It anchors to whichever field the chosen basis
 *   renders — `#riskPercent` or `#dollarRisk` — and names both.
 * - Selecting an account seeds `riskPercent` from `account.defaultRiskPercent`
 *   ONLY when the account carries one — an account without a default leaves the
 *   field empty — and an edit there never writes back to the account.
 * - An account also supplies the display currency and the buying-power cap, in
 *   both risk bases.
 * - `positionSize` is floored to whole units, which is why the actual dollar
 *   risk lands at or under the budget rather than on it.
 * - Card titles are "Position Sizing" and "Risk / Reward"; the rows named below
 *   are that component's own labels. Risk / Reward renders only with a target.
 *
 * BESIDE THE FORM, NEVER OVER IT — every field step declares `side: 'right'`.
 *
 * `CalculatorForm` is a two-column grid: the form on the left, the results on
 * the right. Left to itself driver.js put the popover wherever it happened to
 * fit, which on a short page is BELOW the field it is describing and therefore
 * on top of the next two. Measured in Chromium at 1280x720, reached the way a
 * user with no account reaches it — the entry-price popover at x 254-554,
 * y 472-680 sat squarely over the middle of both Stop loss and Target price
 * (x 264-748). It moved as the page did: the same step, on the same viewport,
 * placed itself to the RIGHT for a user who had an account, so this was a
 * defect that appeared and disappeared with the layout rather than one anybody
 * would reliably see and report.
 *
 * Right of the field is the results column, which is read-only: `CalculatorResults`
 * renders figures and no controls at all, so nothing there can be covered.
 * Declaring it also stops the placement moving with the page height.
 *
 * THE LAST STEP IS THE ONE THAT CANNOT BE BESIDE ANYTHING, and it is left over
 * the form on purpose. It anchors to the results panel, and driver.js will only
 * use a side the popover fits on: measured in Chromium at 1280x720, the panel
 * lands at x 772-1256, y 0-780 once driver.js has scrolled it in, and the
 * popover is 300x268. Above wants 278px over a top edge at 0, below wants 278px
 * under a bottom edge at 780, right wants 300px past 1256 — none of the three
 * exist, so `left` is the only side there is, whatever the step declares, and
 * left is x 452-752 against a form column at x 264-748. Centring instead is
 * worse, not better: driver.js centres on the VIEWPORT rather than on the
 * element, which is x 490-790, y 226-494 — three fields rather than two.
 *
 * What it covers there is `#symbol` whole and the top 10px of `#entryPrice`,
 * and neither is anybody's to press: a running tour holds the page inert and
 * the wash says so. That is the one case `e2e/support/popover-clearance.ts`
 * gates out by design, and the reason it reads `pointer-events` rather than
 * geometry alone. It went red here once, and the popover was not what had
 * moved — the tour had leaked a live control under it. See `tour-engine.ts`,
 * `releaseStaleHighlights`.
 */

import type { WalkthroughStepSource } from './index';

export const calculatorSteps: readonly WalkthroughStepSource[] = [
  {
    target: '#entryPrice',
    route: '/calculator',
    docs: 'gettingStarted',
    // The set is entered COLD, from the checklist on another route, so the first
    // step waits for the calculator to mount rather than assuming the
    // navigation has already landed.
    waitForMs: 5000,
    side: 'right',
    title: 'Entry price',
    body:
      'Start with the price you plan to get in at. Nothing here is submitted or saved — the ' +
      'calculator recomputes as you type, so you can try a setup and change your mind.',
  },
  {
    target: '#stopLoss',
    route: '/calculator',
    docs: 'gettingStarted',
    side: 'right',
    title: 'Stop loss',
    body:
      'The price at which you would accept the trade is wrong. The distance from entry to stop ' +
      'is what the results call Per-unit risk, and the position size is derived from it — a ' +
      'wider stop buys fewer units for the same money at risk.',
  },
  {
    target: '#targetPrice',
    route: '/calculator',
    docs: 'gettingStarted',
    side: 'right',
    title: 'Target price (optional)',
    body:
      'Optional, as the label says. Add it and you also get the Per-unit reward and the ' +
      'Risk/Reward ratio; leave it out and you still get a size.',
  },
  {
    target: '[data-tour="calculator-risk"]',
    route: '/calculator',
    docs: 'gettingStarted',
    side: 'right',
    actionHint: 'Choose the Percent basis',
    advanceOnAction: true,
    title: 'Risk',
    body:
      'Now say how much you are willing to lose. Dollar is a figure you type; Percent sizes it ' +
      'from an account balance and a risk percentage. Choose Percent to use the rule you set on ' +
      'the account.',
  },
  {
    target: '[data-tour="calculator-account"]',
    route: '/calculator',
    docs: 'gettingStarted',
    waitForMs: 3000,
    side: 'right',
    actionHint: 'Pick an account',
    advanceOnAction: true,
    title: 'Account',
    body:
      'Pick the account you are trading. Under Percent it supplies the balance to size against, ' +
      'and in either basis it supplies the currency and caps the position at the buying power ' +
      'the account actually has. An account with a brokerage attached also brings that ' +
      'brokerage&rsquo;s fee schedule into the estimate for you — under Fees you can still ' +
      'change or clear it.',
  },
  {
    // Whichever field the basis chosen two steps ago renders; exactly one of the
    // two is on screen at a time, so the selector list resolves unambiguously.
    target: '#riskPercent, #dollarRisk',
    route: '/calculator',
    docs: 'gettingStarted',
    waitForMs: 3000,
    side: 'right',
    title: 'The amount at risk',
    body:
      'Under Percent, Risk percent is prefilled from that account&rsquo;s Default risk % when it ' +
      'has one; under Dollar, Dollar risk is the figure you type. Either way the change applies ' +
      'to this calculation only — the account keeps its rule, so the number you rely on tomorrow ' +
      'is still the one you chose.',
  },
  {
    target: '[data-tour="calculator-results"]',
    route: '/calculator',
    docs: 'metricsGlossary',
    side: 'left',
    title: 'Size, risk and R:R',
    body:
      'Position Sizing gives you the Position size in whole units, the Per-unit risk, and the ' +
      'Actual dollar risk once that size is rounded down. With a target, Risk / Reward adds the ' +
      'Per-unit reward and the Risk/Reward ratio — what the plan pays if it works, per unit of ' +
      'what it costs if it does not.',
  },
];

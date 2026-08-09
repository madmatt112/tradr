/**
 * Checklist item 3 — log a position (R6.8).
 *
 * Starts on `/positions` and ends on `/positions/$positionId`, the two routes
 * `routes/_auth/positions/` declares.
 *
 * EVERY CLAIM, AND WHERE IT WAS CHECKED:
 * - The three states are `draft | open | closed`
 *   (`packages/shared/src/schemas/position.ts`), and a newly created position is
 *   a draft (`positions.test.ts` pins the created status).
 * - A DRAFT AFFECTS NO BALANCE, and it is enforced rather than merely intended:
 *   `accounts.query.ts` counts only `status = 'open'` into position value and
 *   says so in its own comment — "Drafts are excluded: they never post to the
 *   ledger" — and `positions.service.ts` refuses an exit fill while draft.
 * - `CreatePositionDialog` asks for Symbol, Side, Asset Type, Account and
 *   Notes, and nothing else; `#symbol` is the stock-mode id and Stock is the
 *   default asset type.
 * - `FillDialog` offers Type Entry / Exit — Entry only while the position is a
 *   draft — with Price, Quantity, Fees, Date & Time and Notes.
 * - "Open Position" is disabled until an entry fill exists, with the tooltip
 *   "Add an entry fill first" (`PositionDetail.tsx`), which is why the fill step
 *   comes before the open step.
 * - OPENING POSTS NOTHING TO THE LEDGER, and that is the only claim the open
 *   step may make about P&L. Realised P&L is posted by the FILL hook
 *   (`postFillLedgerEntries`), which runs on every fill, so the first exit moves
 *   the balance whether or not the position is closed — and the exit that
 *   balances the entry closes it by itself (`addFill` in `positions.service.ts`).
 *   An open position's cost is held against the account as position value:
 *   `accounts.query.ts` counts `status = 'open'` rows only.
 */

import type { WalkthroughStepSource } from './index';

export const positionSteps: readonly WalkthroughStepSource[] = [
  {
    target: '[data-tour="position-new"]',
    route: '/positions',
    docs: 'positions',
    // The set is entered COLD — from the checklist, on another route — so the
    // first step waits like any other. `PositionList` renders an UNTAGGED
    // disabled "New Position" until `useAccounts` resolves, and only swaps in
    // the tagged enabled one once it has: without this the tour exits
    // `target-missing` on a screen that was about to be ready.
    waitForMs: 5000,
    advanceOnAction: true,
    title: 'Log the position',
    body:
      'A position in Tradr is one trade and every fill that belongs to it. Choose New Position ' +
      'to start the one you just sized.',
  },
  {
    target: '#symbol',
    route: '/positions',
    docs: 'positions',
    waitForMs: 3000,
    advanceOnAction: true,
    title: 'Symbol, side and account',
    body:
      'The ticker, whether you are long or short, and the account it is booked against. Notes ' +
      'are worth filling in now — why you took the trade is the part you will want back later.',
  },
  {
    target: '[data-tour="position-add-fill"]',
    route: '/positions/$positionId',
    routeParams: ['positionId'],
    docs: 'positions',
    waitForMs: 5000,
    advanceOnAction: true,
    title: 'It starts as a draft',
    body:
      'What you just made is a draft: a plan, not a trade. It posts nothing to your ledger and ' +
      'leaves the account balance exactly where it was, so you can plan a trade you never take. ' +
      'Add Fill is what turns it into one — the price and quantity you actually got, plus any ' +
      'fees.',
  },
  {
    target: '[data-tour="position-open"]',
    route: '/positions/$positionId',
    routeParams: ['positionId'],
    docs: 'positions',
    waitForMs: 3000,
    advanceOnAction: true,
    title: 'Open the position',
    body:
      'With an entry fill recorded, Open Position moves it from draft to open. Its cost is now ' +
      'held against the account as position value; realised P&amp;L is a separate thing, and ' +
      'nothing is realised until you start exiting. Each exit fill books its share of the ' +
      'result to the account as you record it.',
  },
  {
    // Centred, and deliberately last. `advanceOnAction` has no effect on a final
    // step — the engine substitutes "Done" for "Next" — so the action-gated
    // step above needs something after it, or the user would be asked to open
    // the position by a button that ends the tour instead (tour-engine.ts).
    route: '/positions/$positionId',
    routeParams: ['positionId'],
    docs: 'positions',
    title: 'That is a position logged',
    body:
      'Draft, open, closed: three states, and you have used two of them. The Positions list ' +
      'filters by each one, so a plan you have not taken never sits among the trades you have.',
  },
];

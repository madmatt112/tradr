/**
 * Checklist item 4 — close it and see the stats (R6.9).
 *
 * Starts on `/positions/$positionId` and lands on `/dashboard`, so the last
 * thing this walkthrough does is show the user their own figures on the screen
 * that was empty when they started.
 *
 * EVERY CLAIM, AND WHERE IT WAS CHECKED:
 * - `FillDialog` offers Type Exit once the position is open, alongside Price,
 *   Quantity, Fees and Date & Time; a position can carry several exit fills,
 *   which is what a partial exit is.
 * - "Close Position" is disabled until the full entered quantity has been
 *   exited, with the tooltip "Exit the full quantity first"
 *   (`PositionDetail.tsx`).
 * - Closing is the point realised P&L reaches the ledger — the close hook in
 *   `positions.service.ts` posts it — and the account balance is
 *   `startingBalance + SUM(ledger)`, so that is the moment the balance moves.
 * - `[data-grid-mode]` is `DashboardGrid`'s own attribute, set on both the
 *   desktop grid and the mobile stack, so the closing step anchors to the
 *   widgets at any width.
 */

import type { WalkthroughStepSource } from './index';

export const closeSteps: readonly WalkthroughStepSource[] = [
  {
    target: '[data-tour="position-add-fill"]',
    route: '/positions/$positionId',
    docs: 'positions',
    advanceOnAction: true,
    title: 'Record the exit',
    body:
      'Add a fill with the type set to Exit, at the price and quantity you actually closed at. ' +
      'Partial exits are ordinary — add one fill per exit and Tradr averages them for you.',
  },
  {
    target: '[data-tour="position-close"]',
    route: '/positions/$positionId',
    docs: 'positions',
    waitForMs: 3000,
    advanceOnAction: true,
    title: 'Close the position',
    body:
      'Once the whole quantity you entered has been exited, Close Position finishes the trade. ' +
      'This is the point your realised P&amp;L is booked to the account and the balance moves — ' +
      'the reason a draft changed nothing and this does.',
  },
  {
    target: '[data-grid-mode]',
    route: '/dashboard',
    docs: 'gettingStarted',
    waitForMs: 5000,
    title: 'And there it is',
    body:
      'Back on the dashboard, with figures in it. Everything here is derived from the trades you ' +
      'log — the stats, the equity curve and your account balance all just moved because you ' +
      'closed one position. Log the next one and they move again.',
  },
];

/**
 * Checklist item 3 — log a position.
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
 *   default asset type. Symbol is the same `SymbolAutocomplete` the calculator
 *   uses, so "searches as you type" is true of both screens.
 * - `[data-tour="position-submit"]` is the dialog's Create button.
 *
 * WHY CREATING THE POSITION HAS A STEP OF ITS OWN, and did not always. The
 * field step used to carry `advanceOnAction` itself: it described four controls
 * and then waited for the position to be created, which is an instruction it
 * never actually gave. A gated step ignores "Next" by design, so a user who
 * filled the form in and pressed the only obvious control got nothing, with
 * nothing on screen to say what was wanted — the reported stall. The account set
 * never had this problem because it already separates its field steps from a
 * final "Choose Create" step, and this set now matches it: the fields advance on
 * "Next", and the action step points at the button that performs the action.
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
    // BESIDE THE BUTTON, NOT UNDER IT. The control sits at the top right of the
    // page and the popover is tall enough that driver.js's default placement
    // clamps it back up over its own anchor — measured at 1280x720, the tour
    // stood on the very control it was telling the user to press. To the left it
    // clears the anchor with room to spare.
    side: 'left',
    align: 'start',
    actionHint: 'Choose New Position',
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
    // THE WAIT COVERS A PERSON, NOT A RENDER, and that is why it is this long.
    // The step before asks for a gesture the app publishes nothing for, so
    // `useWalkthrough` lets "Next" drive it — and a user who presses Next before
    // opening the dialog is asking for a field that arrives when they get round
    // to it. A render-sized wait gives up while they are still reading, which
    // ends the walkthrough on a target that was about to exist. It still ends
    // cleanly for a dialog that is genuinely never opened.
    waitForMs: 15000,
    // BESIDE THE FORM, NEVER OVER IT. This one step describes four controls —
    // Symbol, Side, Asset Type and Account — and waits for the user to fill in
    // all of them, so the popover cannot sit where driver.js would put it by
    // default. Below `#symbol` is exactly on top of Side, Asset Type and
    // Account: at 1280x720 the popover covered all three, `elementFromPoint`
    // returned the popover and a pointer never reached them. To the side it
    // clears the dialog, which is the only placement that leaves every control
    // this step names usable — which is the whole reason the highlighted
    // control is left interactive in the first place.
    side: 'right',
    align: 'start',
    title: 'Symbol, side and account',
    body:
      'The ticker, whether you are long or short, and the account it is booked against. Symbol ' +
      'searches as you type, the same as the calculator does. Notes are worth filling in now — ' +
      'why you took the trade is the part you will want back later.',
  },
  {
    target: '[data-tour="position-submit"]',
    route: '/positions',
    docs: 'positions',
    // BESIDE THE DIALOG, NOT ABOVE THE FOOTER — and that is a measurement, not a
    // preference. The account set's submit step goes `top`/`end`, but that
    // dialog is a tall form whose footer has clear space above it. This one is
    // short: placed above the Create button the popover came down on the Notes
    // textarea, the Account select and Cancel — three controls the user can
    // still press, which `expectPromptClearOfEveryControl` fails on. `right` is
    // the placement the field step above already proves clears this dialog.
    side: 'right',
    align: 'end',
    actionHint: 'Choose Create',
    advanceOnAction: true,
    title: 'Create the position',
    body:
      'Choose Create. Nothing is committed to your account yet — what you get is a draft, which ' +
      'is the subject of the next step.',
  },
  {
    target: '[data-tour="position-add-fill"]',
    route: '/positions/$positionId',
    routeParams: ['positionId'],
    docs: 'positions',
    waitForMs: 5000,
    // ABOVE THE BUTTON, NOT BESIDE IT, and for the reason the step before is
    // beside the form rather than over it. What finishes this step is the Add
    // button inside the fill dialog, and Add Fill sits at the right edge of the
    // page, so driver.js's default placement puts the popover to its LEFT: at
    // 1280x720 that reaches x=850 while the dialog runs to x=896, laying 21px of
    // popover across Add and across the Notes field above it. Placed above, the
    // popover stays clear of the dialog it just told the user to open.
    side: 'top',
    actionHint: 'Add the entry fill',
    advanceOnAction: true,
    title: 'It starts as a draft',
    body:
      'A draft is a plan, not a trade: it posts nothing to your ledger and leaves the balance ' +
      'where it was. Add Fill records what you actually got.',
  },
  {
    target: '[data-tour="position-open"]',
    route: '/positions/$positionId',
    routeParams: ['positionId'],
    docs: 'positions',
    waitForMs: 3000,
    // BESIDE THE BUTTON. Open Position sits at the top right of the detail page,
    // and driver.js's default places the popover below it starting 12px inside
    // the button — measured at 1280x720, popover y 48 against a button ending at
    // y 60. The same shape, and the same fix, as the two sets' opening steps.
    side: 'left',
    align: 'start',
    actionHint: 'Choose Open Position',
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

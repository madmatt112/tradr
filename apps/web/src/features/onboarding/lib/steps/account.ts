/**
 * Checklist item 1 — create a brokerage account.
 *
 * RUNS ENTIRELY ON `/accounts`, AND THAT IS WHAT MAKES IT REPEATABLE. It used to
 * run on `/dashboard`, against the zero-state's "Create my first account" — a
 * screen the dashboard renders only while the user has no accounts at all. That
 * anchored the whole set to a screen every user leaves within a minute of
 * arriving and never sees again, so the one walkthrough about creating an
 * account could not be replayed by anybody who had created one. `/accounts` is
 * where a second account is actually made, it is on the sidebar for every user,
 * and it mounts the SAME `AccountDialog` the zero-state does — so every field
 * step below is unchanged, and the set now runs for the user who has finished
 * onboarding as well as the one who has not started.
 *
 * No step navigates: the dialog opens over this route, as it did over the other.
 *
 * EVERY CLAIM, AND WHERE IT WAS CHECKED:
 * - Booked against an account, mirrors a real brokerage account, never places
 *   or executes trades — `ZeroState.tsx` states both halves in these words.
 * - Field labels and order follow `AccountDialog.tsx` exactly: Name, Currency,
 *   Trading-day timezone, Starting balance, Default risk %, Brokerage. The
 *   targets are the ids that file already sets.
 * - `America/New_York` is `DEFAULT_ACCOUNT_TIMEZONE`
 *   (`packages/shared/src/constants/timezones.ts`), prefilled from the constant
 *   and not from the browser, and governs the same-day re-entry boundary only.
 * - Starting balance is creation-only: the field renders under `!isEdit`, and
 *   `UpdateAccountSchema` deliberately omits it because the shown balance is
 *   `startingBalance + SUM(ledger)` (`packages/shared/src/schemas/account.ts`).
 * - Default risk % is a fixed set of options you pick one of, not a free-text field:
 *   `RISK_PRESETS` in `AccountDialog.tsx` is 1% / 2% / 3%, each labelled with
 *   the drawdown ten losing trades in a row would compound to, plus a "No rule"
 *   option whose value is `undefined`. `DEFAULT_RISK_PRESET` is '2' and seeds
 *   CREATE only. It stays editable after creation, and is read-only into the
 *   calculator — `CalculatorForm.seedRiskPercent` sets the form field only when
 *   the account has a rule, and never writes back.
 * - An unset brokerage is valid (`brokerageId` is nullable, the select offers
 *   "None"); a set one is what joins `fee_schedules` in `positions.query.ts`.
 * - The reporting timezone is a separate per-user value, seeded at registration
 *   from the browser (`routes/register.tsx`) and edited under Settings →
 *   Profile (`ReportingTimezoneSelect`). A user must not be able to conclude
 *   that setting one has set the other, so the trading-day step disclaims it
 *   and this set closes by naming it on its own.
 */

import type { WalkthroughStepSource } from './index';

export const accountSteps: readonly WalkthroughStepSource[] = [
  {
    target: '[data-tour="account-new"]',
    route: '/accounts',
    docs: 'gettingStarted',
    // The set is entered COLD, so its first step waits like any other:
    // `AccountList` renders skeletons until `useAccounts` has answered, and the
    // button this points at is on the branch it takes afterwards. Without this
    // the tour would exit `target-missing` before the screen it is describing
    // has finished arriving.
    waitForMs: 5000,
    advanceOnAction: true,
    title: 'Start with an account',
    body:
      'Every position, fill and ledger entry is booked against an account, so this is the one ' +
      'thing to do first. A Tradr account mirrors a real brokerage account — the same currency, ' +
      'the same starting balance, the same trades — but it is not connected to your broker, and ' +
      'Tradr never places or executes trades. Choose New Account to open the form.',
  },
  {
    target: '#name',
    route: '/accounts',
    docs: 'gettingStarted',
    // THE WAIT COVERS A PERSON, NOT A RENDER, and that is why it is this long.
    // The step before asks the user to open the account dialog, a gesture the
    // app publishes nothing for, so `useWalkthrough` lets "Next" drive it — and
    // pressing Next before opening the dialog is the ordinary thing to do, since
    // the step says nothing about a button. A render-sized wait gave up three
    // seconds later and ended the walkthrough on a field that was about to
    // exist. It still ends cleanly for a dialog that is genuinely never opened.
    waitForMs: 15000,
    title: 'Name',
    body:
      'Name the account after the brokerage account it mirrors. You pick it by this name every ' +
      'time you log a position, so make it one you will recognise when you have more than one.',
  },
  {
    target: '#currency',
    route: '/accounts',
    docs: 'gettingStarted',
    title: 'Currency',
    body:
      'The currency this account trades in. Its balance, fees and P&amp;L are all recorded and ' +
      'shown in this currency.',
  },
  {
    target: '#timezone',
    route: '/accounts',
    docs: 'gettingStarted',
    title: 'Trading-day timezone',
    body:
      'This defaults to America/New_York because NYSE, NASDAQ and NYSE Arca all operate on US ' +
      'Eastern. It defines the trading day for this account, which is what decides whether a ' +
      'position can be re-entered the same day. It is not your reporting timezone — that one ' +
      'buckets your P&amp;L and is set separately, under Settings → Profile.',
  },
  {
    target: '#startingBalance',
    route: '/accounts',
    docs: 'gettingStarted',
    title: 'Starting balance',
    body:
      'The account&rsquo;s opening cash, and the baseline every later figure is measured against. ' +
      'Set it once, here: the balance Tradr shows you is this figure plus every ledger entry, so ' +
      'editing it afterwards would move every historical balance with it. That is why it cannot ' +
      'be changed once the account exists. Leave it empty and the account starts at zero.',
  },
  {
    target: '#defaultRiskPercent',
    route: '/accounts',
    docs: 'gettingStarted',
    title: 'Default risk %',
    body:
      'The share of this account&rsquo;s balance you risk on a single trade. It prefills the ' +
      'position-size calculator, and you can override it on any one calculation without changing ' +
      'the account. Choose 1%, 2% or 3% — each one shows what ten losing trades in a row would ' +
      'cost you — or No rule, which sets none and leaves the calculator&rsquo;s risk percent for ' +
      'you to fill in each time. 2% is chosen for you, and unlike the starting balance you can ' +
      'change it whenever you want.',
  },
  {
    target: '#brokerage',
    route: '/accounts',
    docs: 'gettingStarted',
    title: 'Brokerage',
    body:
      'Choose a brokerage and Tradr calculates and records this account&rsquo;s fees from that ' +
      'brokerage&rsquo;s fee schedule. Leaving it on None is perfectly valid — you then enter ' +
      'fees yourself on each fill — and you can attach a brokerage later.',
  },
  {
    target: '[data-tour="account-submit"]',
    route: '/accounts',
    docs: 'gettingStarted',
    advanceOnAction: true,
    title: 'Create the account',
    body:
      'Choose Create. The account appears in the list behind this form as soon as it exists, and ' +
      'you can book positions against it straight away.',
  },
  {
    // No target: the reporting timezone is not a control on this screen, and the
    // invitation belongs at the point the account is created rather than as a
    // detour into settings mid-walkthrough. Centred, so it reads as the aside it
    // is.
    route: '/accounts',
    docs: 'gettingStarted',
    title: 'Your reporting timezone',
    body:
      'One more zone, and it is a different one. Separately from the account you just made, ' +
      'Tradr stores a single reporting timezone for you: the zone your P&amp;L is bucketed into ' +
      'by day, week and month, so those figures stay the same wherever you open Tradr. One was ' +
      'stored when you registered. Confirm or correct it under Settings → Profile, where it is ' +
      'shown prefilled with the zone on record.',
  },
];

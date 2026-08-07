/**
 * Checklist item 1 — create a brokerage account (R6.1–R6.6).
 *
 * Runs entirely on `/dashboard`: the zero-state mounts `AccountDialog` itself,
 * so the form opens over the same route the tour started on and no step here
 * navigates.
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
 * - Default risk % is optional, strictly positive, at most 100 with two
 *   decimals, editable after creation, and read-only into the calculator —
 *   `CalculatorForm.seedRiskPercent` sets the form field and never writes back.
 * - An unset brokerage is valid (`brokerageId` is nullable, the select offers
 *   "None"); a set one is what joins `fee_schedules` in `positions.query.ts`.
 * - The reporting timezone is a separate per-user value, seeded at registration
 *   from the browser (`routes/register.tsx`) and edited under Settings →
 *   Profile (`ReportingTimezoneSelect`). R2.8 forbids conflating the two, so the
 *   trading-day step disclaims it and this set closes by naming it on its own.
 */

import type { WalkthroughStepSource } from './index';

export const accountSteps: readonly WalkthroughStepSource[] = [
  {
    target: '[data-testid="zero-state-create-account"]',
    route: '/dashboard',
    docs: 'gettingStarted',
    advanceOnAction: true,
    title: 'Start with an account',
    body:
      'Every position, fill and ledger entry is booked against an account, so this is the one ' +
      'thing to do first. A Tradr account mirrors a real brokerage account — the same currency, ' +
      'the same starting balance, the same trades — but it is not connected to your broker, and ' +
      'Tradr never places or executes trades. Choose Create my first account to open the form.',
  },
  {
    target: '#name',
    route: '/dashboard',
    docs: 'gettingStarted',
    waitForMs: 3000,
    title: 'Name',
    body:
      'Name the account after the brokerage account it mirrors. You pick it by this name every ' +
      'time you log a position, so make it one you will recognise when you have more than one.',
  },
  {
    target: '#currency',
    route: '/dashboard',
    docs: 'gettingStarted',
    title: 'Currency',
    body:
      'The currency this account trades in. Its balance, fees and P&amp;L are all recorded and ' +
      'shown in this currency.',
  },
  {
    target: '#timezone',
    route: '/dashboard',
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
    route: '/dashboard',
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
    route: '/dashboard',
    docs: 'gettingStarted',
    title: 'Default risk %',
    body:
      'The share of this account&rsquo;s balance you risk on a single trade. It prefills the ' +
      'position-size calculator, and you can override it on any one calculation without changing ' +
      'the account. If you do not have a rule of your own yet, 3% is a conservative starting ' +
      'point. Leave it empty to set no rule; you can add one later.',
  },
  {
    target: '#brokerage',
    route: '/dashboard',
    docs: 'gettingStarted',
    title: 'Brokerage',
    body:
      'Choose a brokerage and Tradr calculates and records this account&rsquo;s fees from that ' +
      'brokerage&rsquo;s fee schedule. Leaving it on None is perfectly valid — you then enter ' +
      'fees yourself on each fill — and you can attach a brokerage later.',
  },
  {
    target: '[data-tour="account-submit"]',
    route: '/dashboard',
    docs: 'gettingStarted',
    advanceOnAction: true,
    title: 'Create the account',
    body:
      'Choose Create. Your dashboard replaces this welcome screen as soon as the account exists, ' +
      'and the first item on the setup checklist ticks itself.',
  },
  {
    // No target: the reporting timezone is not a control on this screen, and
    // R6.6 asks for the invitation at the point the account is created rather
    // than for a detour into settings mid-walkthrough. Centred, so it reads as
    // the aside it is.
    route: '/dashboard',
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

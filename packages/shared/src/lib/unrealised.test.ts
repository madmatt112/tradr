import { describe, expect, it } from 'vitest';

import { computeUnrealised } from './unrealised';

// Contract (per AC; "design C5" = design.md's Unrealised figure section):
// - AC 3.1, 3.2, 3.3, 3.4, 3.6 (example 1) — computeUnrealised(input): pre-condition
//   is a long stock row, no exits, entry fees 1.00; call is
//   `computeUnrealised({ side: 'long', openQty: 10, openCostBasis: 1001, lastPrice: '110.00', currency: 'USD' })`;
//   observable result is `{ marketValue, unrealisedPnl, unrealisedPercent }`;
//   expected values (1100, 99.00, 9.89) are the first Requirement 3.6 worked
//   example, reproduced by design C5's decimal.js proof.
// - AC 3.1, 3.2, 3.3, 3.4, 3.6 (example 2) — same call shape with
//   `{ side: 'short', openQty: 10, openCostBasis: -999, lastPrice: '90.00', currency: 'USD' }`;
//   expected (-900, 99.00, 9.91) is the second Requirement 3.6 example, pinning
//   `sideSign = -1` for short (AC 3.1) and the absolute-value percent denominator
//   (AC 3.4) against a negative `openCostBasis`.
// - AC 3.1, 3.2, 3.3, 3.4, 3.6 (example 3) — same call shape with
//   `{ side: 'long', openQty: 6, openCostBasis: 600.6, lastPrice: '110.00', currency: 'USD' }`
//   (4 of 10 exited); expected (660, 59.40, 9.89) is the third Requirement 3.6
//   example, pinning the partial-exit `openQty`.
// - AC 3.5, 3.6 (example 4) — same call shape with
//   `{ side: 'long', openQty: 10, openCostBasis: 1000, lastPrice: '100.00', currency: 'USD' }`
//   (no fees, flat); expected (1000, 0, 0) is the fourth Requirement 3.6 example,
//   proving a flat position renders the zero figure, not the absent `null`.
// - AC 3.5 (openQty 0) — pre-condition is `openQty: 0` with a nonzero
//   `openCostBasis`; call is `computeUnrealised({ side: 'long', openQty: 0,
//   openCostBasis: 500, lastPrice: '110.00', currency: 'USD' })`; observable
//   result is the return value; expected is `null` (Requirement 3.5, first
//   branch).
// - AC 3.5 (openCostBasis 0) — pre-condition is `openCostBasis: 0` with a
//   nonzero `openQty`; call is `computeUnrealised({ side: 'long', openQty: 10,
//   openCostBasis: 0, lastPrice: '110.00', currency: 'USD' })`; observable
//   result is the return value; expected is `null` (Requirement 3.5, second
//   branch).
// - AC 3.3 (ROUND_HALF_UP) — pre-condition is a raw pnl that lands exactly on a
//   half-cent boundary (`marketValue - openCostBasis === 0.995`); call is
//   `computeUnrealised({ side: 'long', openQty: 1, openCostBasis: 20,
//   lastPrice: '20.995', currency: 'USD' })`; observable result is
//   `unrealisedPnl`; expected is `1` — design C5's "rounded once, half-up"
//   post-condition requires the half-cent to round away from zero, not to the
//   nearest even cent (banker's rounding) or be truncated by a float `toFixed`.
// - AC 3.3 (currency minor units) — pre-condition is a currency whose
//   `getCurrencyMinorUnits` is 0, not 2 (`packages/shared/src/constants/currencies.ts`,
//   JPY); call is `computeUnrealised({ side: 'long', openQty: 1, openCostBasis: 100,
//   lastPrice: '105.6', currency: 'JPY' })`; observable result is
//   `unrealisedPnl`; expected is `6` (5.6 rounded half-up to 0 decimal places) —
//   pins that the rounding scale comes from `getCurrencyMinorUnits(currency)`,
//   not a hard-coded 2.
// - AC 3.4 / design D9 — pre-condition is a raw pnl (0.995) whose half-up
//   rounding to cents (1.00) gives a different percent than dividing the raw,
//   unrounded pnl by the cost basis would; call is `computeUnrealised({ side:
//   'long', openQty: 1, openCostBasis: 20, lastPrice: '20.995', currency: 'USD'
//   })`; observable result is `unrealisedPercent`; expected is `5` (1.00 / 20 *
//   100), not `4.98` (0.995 / 20 * 100 rounded) — design D9: "Unrealised percent
//   divides the rounded P&L figure".

describe('computeUnrealised', () => {
  it('worked example 1 — long, full position, no exits (AC 3.1, 3.2, 3.3, 3.4, 3.6)', () => {
    const result = computeUnrealised({
      side: 'long',
      openQty: 10,
      openCostBasis: 1001,
      lastPrice: '110.00',
      currency: 'USD',
    });

    expect(result).toEqual({ marketValue: 1100, unrealisedPnl: 99, unrealisedPercent: 9.89 });
  });

  it('worked example 2 — short, full position, no exits (AC 3.1, 3.2, 3.3, 3.4, 3.6)', () => {
    const result = computeUnrealised({
      side: 'short',
      openQty: 10,
      openCostBasis: -999,
      lastPrice: '90.00',
      currency: 'USD',
    });

    expect(result).toEqual({ marketValue: -900, unrealisedPnl: 99, unrealisedPercent: 9.91 });
  });

  it('worked example 3 — long, partial exit (AC 3.1, 3.2, 3.3, 3.4, 3.6)', () => {
    const result = computeUnrealised({
      side: 'long',
      openQty: 6,
      openCostBasis: 600.6,
      lastPrice: '110.00',
      currency: 'USD',
    });

    expect(result).toEqual({ marketValue: 660, unrealisedPnl: 59.4, unrealisedPercent: 9.89 });
  });

  it('worked example 4 — flat position renders zero, not absent (AC 3.5, 3.6)', () => {
    const result = computeUnrealised({
      side: 'long',
      openQty: 10,
      openCostBasis: 1000,
      lastPrice: '100.00',
      currency: 'USD',
    });

    expect(result).toEqual({ marketValue: 1000, unrealisedPnl: 0, unrealisedPercent: 0 });
  });

  it('returns null when openQty is 0 (AC 3.5)', () => {
    const result = computeUnrealised({
      side: 'long',
      openQty: 0,
      openCostBasis: 500,
      lastPrice: '110.00',
      currency: 'USD',
    });

    expect(result).toBeNull();
  });

  it('returns null when openCostBasis is 0 (AC 3.5)', () => {
    const result = computeUnrealised({
      side: 'long',
      openQty: 10,
      openCostBasis: 0,
      lastPrice: '110.00',
      currency: 'USD',
    });

    expect(result).toBeNull();
  });

  it('rounds a half-cent pnl half-up, away from zero (AC 3.3)', () => {
    const result = computeUnrealised({
      side: 'long',
      openQty: 1,
      openCostBasis: 20,
      lastPrice: '20.995',
      currency: 'USD',
    });

    expect(result?.unrealisedPnl).toBe(1);
  });

  it('rounds pnl to the currency minor units, not a hard-coded 2 (AC 3.3, JPY)', () => {
    const result = computeUnrealised({
      side: 'long',
      openQty: 1,
      openCostBasis: 100,
      lastPrice: '105.6',
      currency: 'JPY',
    });

    expect(result?.unrealisedPnl).toBe(6);
  });

  it('divides the rounded pnl for percent, not the raw figure (AC 3.4, design D9)', () => {
    const result = computeUnrealised({
      side: 'long',
      openQty: 1,
      openCostBasis: 20,
      lastPrice: '20.995',
      currency: 'USD',
    });

    expect(result?.unrealisedPercent).toBe(5);
  });
});

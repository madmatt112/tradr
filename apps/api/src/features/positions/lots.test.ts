import { describe, it, expect } from 'vitest';

import {
  orderFills,
  matchExitsToLots,
  availableByLot,
  lotEndDates,
  computeLotRealisations,
} from './lots';
import { aggregateFills, computePnlFromTotals } from './pnl';

// ---------------------------------------------------------------------------
// Contract block — one entry per Success criterion in task 3's prompt
// (apps/api/src/features/positions/lots.ts does not exist at base: every
// case below fails at import before it fails on an assertion).
//
// 1. orderFills ties (AC 1.2, AC 3.1)
//    Pre-condition: fills sharing filledAt, and some also sharing createdAt.
//    Call: orderFills(fills).
//    Observable: array order is filledAt, then createdAt, then id.
//    Source: design C4 "orderFills(fills) — filledAt, createdAt, id".
//
// 2. unselected exit takes oldest available, splits, skips reserved
//    (AC 3.2, AC 3.4)
//    Pre-condition: two lots and an unselected exit bigger than one lot;
//    separately, a lot partly reserved by a selected exit.
//    Call: matchExitsToLots(fills, selections).
//    Observable: slices consume the oldest lot first, split across the
//    second, and never dip into reserved quantity.
//    Source: design C4 matching rule.
//
// 3. a selected exit takes exactly its slices (AC 3.3)
//    Pre-condition: an exit selects the YOUNGER of two lots explicitly.
//    Call: matchExitsToLots(fills, selections).
//    Observable: the slice is against the selected lot only, never FIFO's
//    older lot.
//    Source: design C4 "A selected exit takes exactly its slices".
//
// 4. each conflict kind, for its own input
//    Call: matchExitsToLots(fills, selections).
//    Observable / source (design C4's four LotConflict.kind values):
//      - not_an_entry: a selection names an id absent from the fills' entries.
//      - over_claimed: two selected exits' claims on one lot exceed its
//        quantity; carries the claiming exit ids.
//      - sum_mismatch: a selected exit's item quantities don't sum to its
//        own exit quantity.
//      - unmatched: an unselected exit needs more than the lots hold.
//
// 5. availableByLot with and without an excluded exit
//    Call: availableByLot(fills, slices, excludeExitFillId?).
//    Observable: available = lot quantity minus every OTHER exit's slices;
//    excluding the asking exit gives back its own reservation.
//    Source: design C7 "available is the lot quantity less every slice of
//    every exit other than exitFillId", applied to design C4's function.
//
// 6. lotEndDates in both modes (design D9)
//    Call: lotEndDates(fills, slices, method).
//    Observable (FIFO): the latest consuming exit's filledAt once a lot is
//    fully consumed, else null. (Average): every lot gets the latest exit's
//    filledAt once the WHOLE position is flat, else null for every lot.
//    Source: design C4 "Lot end date" / design D9.
//
// 7. long, short and option slices give the AC 5.2 formulas, with
//    gross − fees === net exactly (AC 5.3)
//    Pre-condition: a partial exit (an untouched second lot keeps the
//    position open) so the AC 5.4 residue step never engages.
//    Call: computeLotRealisations(fills, slices, side, assetType, 2).
//    Observable: net, fees, proceeds, basis match design C4's per-slice
//    formulas hand-computed below.
//    Source: design C4 "Realisation, per slice" formulas.
//
// 8. one exit over two lots gives two slices, each at its own lot's price
//    (AC 5.9)
//    Call: computeLotRealisations(...) after a split match.
//    Observable: two rows, each priced off its own lot, basis differing.
//    Source: design C4 + requirements AC 5.9.
//
// 9. on a full exit, Σnet/Σfees/Σ(net+fees) equal computePnlFromTotals
//    exactly, the rounding residue on the latest slice (AC 5.4)
//    Pre-condition: prices chosen so each slice's independently-rounded
//    gross differs from the pooled calculation by a cent.
//    Call: computeLotRealisations(...), then compare against
//    computePnlFromTotals(aggregateFills(fills), ...) on the same fills.
//    Observable: sums match exactly; the earlier slice keeps its raw
//    rounded value, only the latest slice absorbs the residue.
//    Source: design C4 "When exit quantity equals entry quantity..." / AC 5.4.
//
// 10. an exit dated before its lot still matches (AC 3.11)
//    Pre-condition: the only exit's filledAt predates the only lot's
//    filledAt.
//    Call: matchExitsToLots(...), then computeLotRealisations(...).
//    Observable: matching succeeds (no conflict); the realisation still
//    carries the lot's and the exit's own dates through unchanged.
//    Source: requirements AC 3.11.
// ---------------------------------------------------------------------------

function makeFill(
  id: string,
  type: 'entry' | 'exit',
  price: number | string,
  quantity: number | string,
  fees: number | string,
  filledAt: string,
  createdAt: string = filledAt,
) {
  return {
    id,
    type,
    price: String(price),
    quantity: String(quantity),
    fees: String(fees),
    filledAt: new Date(filledAt),
    createdAt: new Date(createdAt),
  };
}

function sel(exitFillId: string, entryFillId: string, quantity: number | string) {
  return { exitFillId, entryFillId, quantity: String(quantity) };
}

function str(x: unknown): string {
  return String(x);
}

function findSlice(
  slices: { exitFillId: string; entryFillId: string; quantity: unknown }[],
  exitFillId: string,
  entryFillId: string,
) {
  return slices.find((s) => s.exitFillId === exitFillId && s.entryFillId === entryFillId);
}

// ---------------------------------------------------------------------------
// 1. orderFills — ties on createdAt, then id (AC 1.2, AC 3.1)
// ---------------------------------------------------------------------------

describe('orderFills', () => {
  it('orders by filledAt, then createdAt, then id', () => {
    const fills = [
      makeFill('zeta', 'entry', 100, 1, 0, '2024-02-01', '2024-02-01'),
      makeFill('omega', 'entry', 100, 1, 0, '2024-01-01', '2024-01-01'), // earliest filledAt
      makeFill('alpha', 'entry', 100, 1, 0, '2024-02-01', '2024-02-01'), // ties zeta on both
      makeFill('mid', 'entry', 100, 1, 0, '2024-02-01', '2024-02-02'), // same filledAt, later createdAt
    ];

    const ordered = orderFills(fills);

    expect(ordered.map((f) => f.id)).toEqual(['omega', 'alpha', 'zeta', 'mid']);
  });
});

// ---------------------------------------------------------------------------
// 2. matchExitsToLots — unselected exits, FIFO split, reservation skip
// ---------------------------------------------------------------------------

describe('matchExitsToLots — unselected exits', () => {
  it('takes the oldest available quantity and splits across lots (AC 3.2, AC 3.4)', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const e2 = makeFill('e2', 'entry', 110, 10, 0, '2024-01-02');
    const x1 = makeFill('x1', 'exit', 120, 15, 0, '2024-01-03');

    const result = matchExitsToLots([e1, e2, x1], []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices).toHaveLength(2);
    expect(str(findSlice(result.slices, 'x1', 'e1')?.quantity)).toBe('10');
    expect(str(findSlice(result.slices, 'x1', 'e2')?.quantity)).toBe('5');
  });

  it('skips the quantity reserved by a selected exit on the same lot (AC 3.4)', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const e2 = makeFill('e2', 'entry', 110, 10, 0, '2024-01-02');
    const x0 = makeFill('x0', 'exit', 105, 4, 0, '2024-01-03'); // selected: claims 4 of e1
    const x1 = makeFill('x1', 'exit', 120, 10, 0, '2024-01-04'); // unselected: needs 10

    const result = matchExitsToLots([e1, e2, x0, x1], [sel('x0', 'e1', 4)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(str(findSlice(result.slices, 'x0', 'e1')?.quantity)).toBe('4');
    // e1 has only 10 - 4 = 6 available for the unselected exit, so it spills to e2.
    expect(str(findSlice(result.slices, 'x1', 'e1')?.quantity)).toBe('6');
    expect(str(findSlice(result.slices, 'x1', 'e2')?.quantity)).toBe('4');
  });
});

describe('matchExitsToLots — selected exits', () => {
  it('takes exactly the selected lot, never the FIFO-oldest one (AC 3.3)', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01'); // older, FIFO's pick
    const e2 = makeFill('e2', 'entry', 110, 10, 0, '2024-01-02'); // younger, the one picked
    const x1 = makeFill('x1', 'exit', 120, 10, 0, '2024-01-03');

    const result = matchExitsToLots([e1, e2, x1], [sel('x1', 'e2', 10)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices).toHaveLength(1);
    expect(str(result.slices[0]!.entryFillId)).toBe('e2');
    expect(str(result.slices[0]!.quantity)).toBe('10');
  });
});

describe('matchExitsToLots — conflicts', () => {
  it('returns not_an_entry for a selection naming a non-entry id', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const x1 = makeFill('x1', 'exit', 110, 5, 0, '2024-01-02');

    const result = matchExitsToLots([e1, x1], [sel('x1', 'ghost', 5)]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict.kind).toBe('not_an_entry');
    expect((result.conflict as { entryFillId: string }).entryFillId).toBe('ghost');
  });

  it('returns over_claimed, with the claiming exit ids, when claims exceed the lot', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const x1 = makeFill('x1', 'exit', 110, 6, 0, '2024-01-02');
    const x2 = makeFill('x2', 'exit', 111, 6, 0, '2024-01-03');

    const result = matchExitsToLots(
      [e1, x1, x2],
      [sel('x1', 'e1', 6), sel('x2', 'e1', 6)], // 6 + 6 = 12 > e1's 10
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict.kind).toBe('over_claimed');
    const conflict = result.conflict as { entryFillId: string; claimingExitFillIds: string[] };
    expect(conflict.entryFillId).toBe('e1');
    expect([...conflict.claimingExitFillIds].sort()).toEqual(['x1', 'x2']);
  });

  it('returns sum_mismatch when the selection items do not sum to the exit quantity', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const x1 = makeFill('x1', 'exit', 110, 10, 0, '2024-01-02');

    const result = matchExitsToLots([e1, x1], [sel('x1', 'e1', 6)]); // exit quantity is 10

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict.kind).toBe('sum_mismatch');
    expect((result.conflict as { exitFillId: string }).exitFillId).toBe('x1');
  });

  it('returns unmatched for an unselected exit beyond what the lots hold', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const x1 = makeFill('x1', 'exit', 110, 15, 0, '2024-01-02'); // only 10 available

    const result = matchExitsToLots([e1, x1], []);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict.kind).toBe('unmatched');
    expect((result.conflict as { exitFillId: string }).exitFillId).toBe('x1');
  });
});

describe('matchExitsToLots — exit dated before its lot (AC 3.11)', () => {
  it('still matches, with no conflict', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-06-01'); // lot opens later
    const x1 = makeFill('x1', 'exit', 110, 5, 0, '2024-01-01'); // exit dated earlier

    const result = matchExitsToLots([e1, x1], []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices).toHaveLength(1);
    expect(str(result.slices[0]!.entryFillId)).toBe('e1');
    expect(str(result.slices[0]!.quantity)).toBe('5');

    const rows = computeLotRealisations([e1, x1], result.slices, 'long', 'stock', 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lotOpenedAt.getTime()).toBe(e1.filledAt.getTime());
    expect(rows[0]!.realisedAt.getTime()).toBe(x1.filledAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// 5. availableByLot — with and without an excluded exit
// ---------------------------------------------------------------------------

describe('availableByLot', () => {
  it("subtracts every exit's slices by default, and gives back an excluded exit's own reservation", () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const x1 = makeFill('x1', 'exit', 110, 4, 0, '2024-01-02');

    const matched = matchExitsToLots([e1, x1], []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const withoutExclusion = availableByLot([e1, x1], matched.slices);
    expect(str(withoutExclusion.find((l) => l.entryFillId === 'e1')?.available)).toBe('6');

    const excludingX1 = availableByLot([e1, x1], matched.slices, 'x1');
    expect(str(excludingX1.find((l) => l.entryFillId === 'e1')?.available)).toBe('10');
  });
});

// ---------------------------------------------------------------------------
// 6. lotEndDates — both modes (design D9)
// ---------------------------------------------------------------------------

describe('lotEndDates — FIFO mode', () => {
  it('dates a fully-consumed lot at its latest consuming exit, and leaves an untouched lot null', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01'); // fully consumed
    const e2 = makeFill('e2', 'entry', 105, 10, 0, '2024-01-02'); // never touched
    const x1 = makeFill('x1', 'exit', 110, 6, 0, '2024-01-03');
    const x2 = makeFill('x2', 'exit', 115, 4, 0, '2024-01-04'); // latest consumer of e1

    const matched = matchExitsToLots([e1, e2, x1, x2], []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const ends = lotEndDates([e1, e2, x1, x2], matched.slices, 'fifo');

    expect(ends.find((l) => l.entryFillId === 'e1')?.endedAt?.getTime()).toBe(
      x2.filledAt.getTime(),
    );
    expect(ends.find((l) => l.entryFillId === 'e2')?.endedAt ?? null).toBeNull();
  });
});

describe('lotEndDates — average mode', () => {
  it('is null for every lot while the position is not fully flat', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const e2 = makeFill('e2', 'entry', 105, 10, 0, '2024-01-02');
    const x1 = makeFill('x1', 'exit', 110, 15, 0, '2024-01-03'); // total exit 15 < total entry 20

    const matched = matchExitsToLots([e1, e2, x1], []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const ends = lotEndDates([e1, e2, x1], matched.slices, 'average');

    expect(ends.find((l) => l.entryFillId === 'e1')?.endedAt ?? null).toBeNull();
    expect(ends.find((l) => l.entryFillId === 'e2')?.endedAt ?? null).toBeNull();
  });

  it("gives every lot the latest exit's filledAt once the position is flat", () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const e2 = makeFill('e2', 'entry', 105, 10, 0, '2024-01-02');
    const x1 = makeFill('x1', 'exit', 110, 15, 0, '2024-01-03');
    const x2 = makeFill('x2', 'exit', 112, 5, 0, '2024-01-04'); // now 15 + 5 = 20, flat

    const matched = matchExitsToLots([e1, e2, x1, x2], []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const ends = lotEndDates([e1, e2, x1, x2], matched.slices, 'average');

    expect(ends.find((l) => l.entryFillId === 'e1')?.endedAt?.getTime()).toBe(
      x2.filledAt.getTime(),
    );
    expect(ends.find((l) => l.entryFillId === 'e2')?.endedAt?.getTime()).toBe(
      x2.filledAt.getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. computeLotRealisations — AC 5.2/5.3 formulas, long/short/option
//
// Each case adds an untouched second lot so the position stays PARTIALLY
// exited at the position level, keeping the AC 5.4 full-exit residue step
// (case 9, below) out of the way of the raw per-slice formula.
// ---------------------------------------------------------------------------

describe('computeLotRealisations — formulas', () => {
  it('computes a long stock slice: gross, fees, proceeds, basis, and gross - fees === net', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 6, '2024-01-01'); // the matched lot
    const e2 = makeFill('e2', 'entry', 200, 10, 0, '2024-01-01'); // keeps the position open
    const x1 = makeFill('x1', 'exit', 110, 10, 4, '2024-01-02');

    const matched = matchExitsToLots([e1, e2, x1], []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const rows = computeLotRealisations([e1, e2, x1], matched.slices, 'long', 'stock', 2);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // gross = (110-100)*10*1*1 = 100; fees = 6*10/10 + 4*10/10 = 10; net = 90
    expect(str(row.net)).toBe('90');
    expect(str(row.fees)).toBe('10');
    // proceeds = exitPrice(long) * q = 110*10 = 1100; basis = proceeds - gross = 1000
    expect(str(row.proceeds)).toBe('1100');
    expect(str(row.basis)).toBe('1000');
  });

  it('computes a short stock slice (sign flips the gross term)', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 6, '2024-01-01'); // short entry (sell to open)
    const e2 = makeFill('e2', 'entry', 90, 10, 0, '2024-01-01');
    const x1 = makeFill('x1', 'exit', 90, 10, 4, '2024-01-02'); // buy to cover

    const matched = matchExitsToLots([e1, e2, x1], []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const rows = computeLotRealisations([e1, e2, x1], matched.slices, 'short', 'stock', 2);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // gross = (90-100)*10*(-1)*1 = 100; fees = 6+4 = 10; net = 90
    expect(str(row.net)).toBe('90');
    expect(str(row.fees)).toBe('10');
    // proceeds (short) = lotPrice * q = 100*10 = 1000; basis = 1000 - 100 = 900
    expect(str(row.proceeds)).toBe('1000');
    expect(str(row.basis)).toBe('900');
  });

  it('applies the 100x contract multiplier for an option slice', () => {
    const e1 = makeFill('e1', 'entry', 2, 5, 6, '2024-01-01');
    const e2 = makeFill('e2', 'entry', 3, 5, 0, '2024-01-01');
    const x1 = makeFill('x1', 'exit', 3, 5, 4, '2024-01-02');

    const matched = matchExitsToLots([e1, e2, x1], []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const rows = computeLotRealisations([e1, e2, x1], matched.slices, 'long', 'option', 2);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // gross = (3-2)*5*1*100 = 500; fees = 6+4 = 10; net = 490
    expect(str(row.net)).toBe('490');
    expect(str(row.fees)).toBe('10');
    // proceeds = 3*5*100 = 1500; basis = 1500-500 = 1000
    expect(str(row.proceeds)).toBe('1500');
    expect(str(row.basis)).toBe('1000');
  });
});

// ---------------------------------------------------------------------------
// 8. one exit over two lots gives two slices, each at its own lot's price
//    (AC 5.9)
// ---------------------------------------------------------------------------

describe('computeLotRealisations — one exit over two lots (AC 5.9)', () => {
  it('gives two rows, each priced and based off its own lot', () => {
    const e1 = makeFill('e1', 'entry', 100, 10, 0, '2024-01-01');
    const e2 = makeFill('e2', 'entry', 105, 10, 0, '2024-01-02');
    const e3 = makeFill('e3', 'entry', 110, 10, 0, '2024-01-03'); // untouched, keeps position open
    const x1 = makeFill('x1', 'exit', 120, 15, 0, '2024-01-04');

    const matched = matchExitsToLots([e1, e2, e3, x1], []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const rows = computeLotRealisations([e1, e2, e3, x1], matched.slices, 'long', 'stock', 2);

    expect(rows).toHaveLength(2);
    const r1 = rows.find((r) => r.entryFillId === 'e1')!;
    const r2 = rows.find((r) => r.entryFillId === 'e2')!;

    // r1: gross=(120-100)*10=200, fees=0, net=200, proceeds=1200, basis=1000
    expect(str(r1.quantity)).toBe('10');
    expect(str(r1.net)).toBe('200');
    expect(str(r1.proceeds)).toBe('1200');
    expect(str(r1.basis)).toBe('1000');

    // r2: gross=(120-105)*5=75, fees=0, net=75, proceeds=600, basis=525
    expect(str(r2.quantity)).toBe('5');
    expect(str(r2.net)).toBe('75');
    expect(str(r2.proceeds)).toBe('600');
    expect(str(r2.basis)).toBe('525');
  });
});

// ---------------------------------------------------------------------------
// 9. full exit — exact residue against computePnlFromTotals, on the latest
//    slice only (AC 5.4)
//
// Prices are chosen so each slice's independently-rounded gross (29.985 →
// 29.99, 35.955 → 35.96) sums to 65.95, one cent above the pooled
// computePnlFromTotals figure of 65.94 — forcing a real residue, not a
// coincidental match.
// ---------------------------------------------------------------------------

describe('computeLotRealisations — full-exit residue (AC 5.4)', () => {
  it('matches computePnlFromTotals exactly in total, correcting only the latest slice', () => {
    const e1 = makeFill('e1', 'entry', 100.005, 3, 0, '2024-01-01');
    const e2 = makeFill('e2', 'entry', 100.015, 3, 0, '2024-01-02');
    const x1 = makeFill('x1', 'exit', 110, 3, 0, '2024-01-03'); // matches e1 fully
    const x2 = makeFill('x2', 'exit', 112, 3, 0, '2024-01-04'); // matches e2 fully, and is the latest exit

    const fills = [e1, e2, x1, x2];
    const matched = matchExitsToLots(fills, []);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;
    expect(matched.slices).toHaveLength(2); // position is fully flat: 6 entered, 6 exited

    const rows = computeLotRealisations(fills, matched.slices, 'long', 'stock', 2);
    const pooled = computePnlFromTotals(aggregateFills(fills), 'long', 'stock', 2);

    const sumNet = rows.reduce((acc, r) => acc + Number(r.net), 0);
    const sumFees = rows.reduce((acc, r) => acc + Number(r.fees), 0);
    const sumGross = rows.reduce((acc, r) => acc + Number(r.net) + Number(r.fees), 0);

    expect(sumNet).toBeCloseTo(pooled.realizedPnl!, 10);
    expect(sumFees).toBeCloseTo(pooled.fees!, 10);
    expect(sumGross).toBeCloseTo(pooled.grossPnl!, 10);

    // Earlier slice (x1 → e1) keeps its raw rounded value: round(9.995*3, 2) = 29.99.
    const earlier = rows.find((r) => r.exitFillId === 'x1')!;
    expect(str(earlier.net)).toBe('29.99');
    expect(str(earlier.fees)).toBe('0');
    expect(str(earlier.proceeds)).toBe('330');
    expect(str(earlier.basis)).toBe('300.01');

    // Latest slice (x2 → e2) absorbs the -0.01 residue: raw round(11.985*3, 2)
    // = 35.96, corrected to 35.95 so the totals land exactly on computePnlFromTotals.
    const latest = rows.find((r) => r.exitFillId === 'x2')!;
    expect(str(latest.net)).toBe('35.95');
    expect(str(latest.fees)).toBe('0');
    expect(str(latest.proceeds)).toBe('336');
    expect(str(latest.basis)).toBe('300.05');
  });
});

import { describe, expect, it } from 'vitest';

import { encodeOccCompact, type LocatedWarning } from '@tradr/shared';

import { proposeGroups } from './csv-group-proposals';
import type { ExecFill, Segment } from './csv-segment';

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion                                              | Pre-condition                                                          | Call (seam)                      | Observable result                                                  | Source of expected value |
 * |----------------------------------------------------------|-------------------------------------------------------------------------|-----------------------------------|----------------------------------------------------------------------|---------------------------|
 * | AC 8.3 pass 1, stock leg included                        | option + stock segment, first executions share a non-empty orderId     | proposeGroups(segments, tz)       | 1 proposal, basis 'order_id', legRefs [0,1], id 'gp-<lowest row>'    | design.md C10 pass 1 + id rule |
 * | AC 8.3 one-segment order id                              | a single segment carries an orderId, no partner                        | proposeGroups(segments, tz)       | proposals: []                                                         | design.md C10 "a one-segment order id proposes nothing" |
 * | AC 8.4 pass 2 pair                                       | 2 option segments, no orderId, same underlying/qty/date, 4 min apart   | proposeGroups(segments, tz)       | 1 proposal, basis 'inferred', legRefs [0,1]                           | design.md C10 pass 2; requirements.md AC 8.4 |
 * | AC 8.4 third fill chains                                 | a third opening fill 4 min after the second, same bucket                | proposeGroups(segments, tz)       | 1 proposal, legRefs [0,1,2]                                           | design.md C10 "chains while the gap... is at most five minutes" |
 * | AC 8.4 gap over 5 min splits                             | third opening fill 6 min after the second                               | proposeGroups(segments, tz)       | 1 proposal, legRefs [0,1] only (the third is excluded)                | design.md C10 chaining rule |
 * | AC 8.6 unequal quantities                                | 2 option segments otherwise matching, differing entry quantity          | proposeGroups(segments, tz)       | proposals: []                                                         | requirements.md AC 8.6 |
 * | AC 8.6 stock never joins an inferred group                | option segment + stock segment matching timing/qty/underlying           | proposeGroups(segments, tz)       | proposals: []                                                         | requirements.md AC 8.6; design.md C10 "Stock segments never enter" |
 * | AC 8.4 timezone, never UTC                               | 2 option segments straddling UTC midnight, same LA calendar day         | proposeGroups(segments, 'America/Los_Angeles') | 1 proposal, basis 'inferred'                            | design.md C10 "trade date in the import timezone"; agent-rules.md Restrictions |
 * | AC 8.5 date-only skip, deduped                           | 2 date-only option segments, no orderId, otherwise matching             | proposeGroups(segments, tz)       | exactly one warning kind 'group_heuristic_skipped'; proposals: []     | design.md C10 "A skip adds one group_heuristic_skipped warning per import" |
 * | AC 8.7 validateLegSet failure dropped                    | 2 segments share an orderId but repeat the same leg symbol              | proposeGroups(segments, tz)       | proposals: []; one warning kind 'group_proposal_dropped' at lowest row; message omits the order id | design.md C10 drop rule; strategy.ts validateLegSet |
 * | AC 8.7 over 8 legs dropped                               | 9 segments share an orderId, otherwise valid                            | proposeGroups(segments, tz)       | proposals: []; one warning kind 'group_proposal_dropped'              | design.md C10 drop rule; strategy.ts MAX_GROUP_LEGS |
 */

const UTC = 'UTC';

function fill(sourceRow: number, overrides: Partial<ExecFill> = {}): ExecFill {
  return {
    type: 'entry',
    price: '100',
    quantity: '1',
    fees: '0',
    filledAt: '2024-03-10T14:00:00.000Z',
    sourceRow,
    ...overrides,
  };
}

function occ(underlying: string, expiration: string, type: 'call' | 'put', strike: string): string {
  const result = encodeOccCompact({ underlying, expiration, type, strike });
  if (!result.ok) {
    throw new Error(`fixture OCC symbol invalid: ${result.error.message}`);
  }
  return result.value;
}

function optionSeg(symbol: string, executions: ExecFill[]): Segment {
  return { scope: { symbol, assetType: 'option' }, side: 'long', executions, closes: false };
}

function stockSeg(symbol: string, executions: ExecFill[]): Segment {
  return { scope: { symbol, assetType: 'stock' }, side: 'long', executions, closes: false };
}

describe('proposeGroups — pass 1, order id (AC 8.3)', () => {
  it('two segments whose first execution shares an order id propose one group, stock leg included', () => {
    const optSymbol = occ('AAPL', '2026-06-19', 'call', '150');
    const segments: Segment[] = [
      optionSeg(optSymbol, [fill(2, { orderId: 'ORD-1' })]),
      stockSeg('AAPL', [fill(3, { orderId: 'ORD-1' })]),
    ];

    const { proposals, warnings } = proposeGroups(segments, UTC);

    expect(warnings).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      id: 'gp-2',
      legRefs: [0, 1],
      basis: 'order_id',
    });
    expect(typeof proposals[0].label).toBe('string');
    // AC 8.11 restriction: the order id itself is never quoted in output.
    expect(JSON.stringify(proposals[0])).not.toContain('ORD-1');
  });

  it('a one-segment order id proposes nothing', () => {
    const optSymbol = occ('AAPL', '2026-06-19', 'call', '150');
    const segments: Segment[] = [optionSeg(optSymbol, [fill(2, { orderId: 'ORD-LONE' })])];

    const { proposals } = proposeGroups(segments, UTC);

    expect(proposals).toEqual([]);
  });
});

describe('proposeGroups — pass 2, heuristic chaining (AC 8.4, 8.6)', () => {
  it('two option segments with no order id, same underlying/qty/date, 4 minutes apart propose one inferred group', () => {
    const a = occ('MSFT', '2026-06-19', 'call', '300');
    const b = occ('MSFT', '2026-06-19', 'call', '310');
    const segments: Segment[] = [
      optionSeg(a, [fill(10, { filledAt: '2024-03-10T14:00:00.000Z', quantity: '2' })]),
      optionSeg(b, [fill(11, { filledAt: '2024-03-10T14:04:00.000Z', quantity: '2' })]),
    ];

    const { proposals } = proposeGroups(segments, UTC);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ basis: 'inferred', legRefs: [0, 1] });
  });

  it('a third opening fill 4 minutes later chains into the same proposal', () => {
    const a = occ('MSFT', '2026-06-19', 'call', '300');
    const b = occ('MSFT', '2026-06-19', 'call', '310');
    const c = occ('MSFT', '2026-06-19', 'call', '320');
    const segments: Segment[] = [
      optionSeg(a, [fill(10, { filledAt: '2024-03-10T14:00:00.000Z', quantity: '2' })]),
      optionSeg(b, [fill(11, { filledAt: '2024-03-10T14:04:00.000Z', quantity: '2' })]),
      optionSeg(c, [fill(12, { filledAt: '2024-03-10T14:08:00.000Z', quantity: '2' })]),
    ];

    const { proposals } = proposeGroups(segments, UTC);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].legRefs).toEqual([0, 1, 2]);
  });

  it('a gap over five minutes splits the chain: the third segment is excluded', () => {
    const a = occ('MSFT', '2026-06-19', 'call', '300');
    const b = occ('MSFT', '2026-06-19', 'call', '310');
    const c = occ('MSFT', '2026-06-19', 'call', '320');
    const segments: Segment[] = [
      optionSeg(a, [fill(10, { filledAt: '2024-03-10T14:00:00.000Z', quantity: '2' })]),
      optionSeg(b, [fill(11, { filledAt: '2024-03-10T14:04:00.000Z', quantity: '2' })]),
      // 6 minutes after b: breaks the rolling 5-minute window.
      optionSeg(c, [fill(12, { filledAt: '2024-03-10T14:10:00.000Z', quantity: '2' })]),
    ];

    const { proposals } = proposeGroups(segments, UTC);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].legRefs).toEqual([0, 1]);
  });

  it('unequal entry quantities propose nothing', () => {
    const a = occ('MSFT', '2026-06-19', 'call', '300');
    const b = occ('MSFT', '2026-06-19', 'call', '310');
    const segments: Segment[] = [
      optionSeg(a, [fill(10, { filledAt: '2024-03-10T14:00:00.000Z', quantity: '2' })]),
      optionSeg(b, [fill(11, { filledAt: '2024-03-10T14:04:00.000Z', quantity: '3' })]),
    ];

    const { proposals } = proposeGroups(segments, UTC);

    expect(proposals).toEqual([]);
  });

  it('a stock segment never joins an inferred group', () => {
    const opt = occ('MSFT', '2026-06-19', 'call', '300');
    const segments: Segment[] = [
      optionSeg(opt, [fill(10, { filledAt: '2024-03-10T14:00:00.000Z', quantity: '2' })]),
      // Same underlying (its own symbol), same quantity, 4 minutes later — would
      // match the option leg's bucket if stock segments were allowed into pass 2.
      stockSeg('MSFT', [fill(11, { filledAt: '2024-03-10T14:04:00.000Z', quantity: '2' })]),
    ];

    const { proposals } = proposeGroups(segments, UTC);

    expect(proposals).toEqual([]);
  });

  it('compares the trade date in the import timezone, never UTC', () => {
    const a = occ('GOOG', '2026-06-19', 'call', '150');
    const b = occ('GOOG', '2026-06-19', 'call', '160');
    // These two fills land on different UTC calendar days (Jan 15 vs Jan 16)
    // but the same calendar day in America/Los_Angeles (UTC-8, no DST on this
    // date): 2024-01-15T23:58Z -> 2024-01-15T15:58-08:00, 2024-01-16T00:02Z ->
    // 2024-01-15T16:02-08:00. A UTC-dated comparison would never group these.
    const segments: Segment[] = [
      optionSeg(a, [fill(20, { filledAt: '2024-01-15T23:58:00.000Z', quantity: '1' })]),
      optionSeg(b, [fill(21, { filledAt: '2024-01-16T00:02:00.000Z', quantity: '1' })]),
    ];

    const { proposals } = proposeGroups(segments, 'America/Los_Angeles');

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ basis: 'inferred', legRefs: [0, 1] });
  });
});

describe('proposeGroups — date-only skip (AC 8.5)', () => {
  it('a date-only segment is skipped, with exactly one group_heuristic_skipped warning even when two are date-only', () => {
    const a = occ('NFLX', '2026-06-19', 'call', '400');
    const b = occ('NFLX', '2026-06-19', 'call', '410');
    const segments: Segment[] = [
      optionSeg(a, [
        fill(30, { filledAt: '2024-03-10T00:00:00.000Z', quantity: '1', dateOnly: true }),
      ]),
      optionSeg(b, [
        fill(31, { filledAt: '2024-03-10T00:00:00.000Z', quantity: '1', dateOnly: true }),
      ]),
    ];

    const { proposals, warnings } = proposeGroups(segments, UTC);

    expect(proposals).toEqual([]);
    const skipWarnings = warnings.filter(
      (w: LocatedWarning) => w.kind === 'group_heuristic_skipped',
    );
    expect(skipWarnings).toHaveLength(1);
  });
});

describe('proposeGroups — drop rules (AC 8.7)', () => {
  it('a proposal failing validateLegSet is dropped with a warning at its first source row, never quoting the order id', () => {
    const repeated = occ('AAPL', '2026-06-19', 'call', '150');
    const segments: Segment[] = [
      optionSeg(repeated, [fill(5, { orderId: 'ORD-DUP' })]),
      // Repeats the same leg symbol -> validateLegSet's "repeated symbol" fault.
      optionSeg(repeated, [fill(6, { orderId: 'ORD-DUP' })]),
    ];

    const { proposals, warnings } = proposeGroups(segments, UTC);

    expect(proposals).toEqual([]);
    const dropped = warnings.filter((w: LocatedWarning) => w.kind === 'group_proposal_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].rowNumber).toBe(5);
    expect(dropped[0].message).not.toContain('ORD-DUP');
  });

  it('a proposal over the 8-leg limit is dropped with a group_proposal_dropped warning', () => {
    const strikes = ['100', '110', '120', '130', '140', '150', '160', '170', '180'];
    const segments: Segment[] = strikes.map((strike, i) =>
      optionSeg(occ('TSLA', '2026-06-19', 'call', strike), [
        fill(100 + i, { orderId: 'ORD-9LEGS' }),
      ]),
    );

    const { proposals, warnings } = proposeGroups(segments, UTC);

    expect(proposals).toEqual([]);
    const dropped = warnings.filter((w: LocatedWarning) => w.kind === 'group_proposal_dropped');
    expect(dropped).toHaveLength(1);
  });
});

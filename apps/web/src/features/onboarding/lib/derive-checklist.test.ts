// @vitest-environment node
//
// node, NOT jsdom: deriveChecklist takes primitives and returns data, so the
// highest-value unit test in the feature must not need a browser to run. If a
// change to the module makes this file need jsdom, the module has stopped being
// pure and that is the bug.

import { describe, expect, it } from 'vitest';

import { type ChecklistInput, type ChecklistItemId, deriveChecklist } from './derive-checklist';

const USED_AT = '2026-08-06T12:00:00.000Z';

/** Build an input from the four completion signals, in checklist order. */
function inputFor(signals: [boolean, boolean, boolean, boolean]): ChecklistInput {
  const [account, calculator, position, close] = signals;
  return {
    accountCount: account ? 1 : 0,
    calculatorFirstUsedAt: calculator ? USED_AT : undefined,
    positionsEverCreatedCount: position ? 1 : 0,
    closedPositionCount: close ? 1 : 0,
  };
}

function doneFlags(input: ChecklistInput): boolean[] {
  return deriveChecklist(input).items.map((item) => item.done);
}

describe('deriveChecklist — shape', () => {
  it('returns exactly the four items, in order, with stable ids and labels', () => {
    const { items } = deriveChecklist(inputFor([false, false, false, false]));

    expect(items).toHaveLength(4);
    expect(items.map((item) => item.id)).toEqual(['account', 'calculator', 'position', 'close']);
    expect(items.map((item) => item.label)).toEqual([
      'Create a brokerage account',
      'Size a trade in the calculator',
      'Log a position',
      'Close it and see the stats',
    ]);
  });

  it('keeps the ids stable regardless of completion state — the step sets join on them', () => {
    const ids: ChecklistItemId[] = ['account', 'calculator', 'position', 'close'];

    expect(deriveChecklist(inputFor([true, true, true, true])).items.map((i) => i.id)).toEqual(ids);
    expect(deriveChecklist(inputFor([false, true, false, true])).items.map((i) => i.id)).toEqual(
      ids,
    );
  });
});

describe('deriveChecklist — truth table', () => {
  // All 16 combinations of the four signals. Each item answers only its own
  // question, so every combination is a legitimate state — including the
  // out-of-order ones. The `allComplete` column is the retirement flag.
  const table: {
    name: string;
    signals: [boolean, boolean, boolean, boolean];
    allComplete: boolean;
  }[] = [
    {
      name: 'fresh user — nothing done',
      signals: [false, false, false, false],
      allComplete: false,
    },

    // Each item alone.
    { name: 'account only', signals: [true, false, false, false], allComplete: false },
    { name: 'calculator only', signals: [false, true, false, false], allComplete: false },
    { name: 'position only', signals: [false, false, true, false], allComplete: false },
    { name: 'closed position only', signals: [false, false, false, true], allComplete: false },

    // Pairs, including out-of-order ones.
    {
      name: 'account + calculator (in order)',
      signals: [true, true, false, false],
      allComplete: false,
    },
    {
      name: 'account + position, calculator skipped',
      signals: [true, false, true, false],
      allComplete: false,
    },
    {
      name: 'account + closed position, middle skipped',
      signals: [true, false, false, true],
      allComplete: false,
    },
    {
      name: 'calculator + position, no account',
      signals: [false, true, true, false],
      allComplete: false,
    },
    {
      name: 'calculator + closed position, no account',
      signals: [false, true, false, true],
      allComplete: false,
    },
    {
      name: 'position + closed position, no account (CSV import)',
      signals: [false, false, true, true],
      allComplete: false,
    },

    // Triples.
    { name: 'all but the close', signals: [true, true, true, false], allComplete: false },
    { name: 'all but the position', signals: [true, true, false, true], allComplete: false },
    { name: 'all but the calculator', signals: [true, false, true, true], allComplete: false },
    { name: 'all but the account', signals: [false, true, true, true], allComplete: false },

    // The retirement case.
    { name: 'all four complete', signals: [true, true, true, true], allComplete: true },
  ];

  it.each(table)('$name', ({ signals, allComplete }) => {
    const result = deriveChecklist(inputFor(signals));

    expect(result.items.map((item) => item.done)).toEqual(signals);
    expect(result.allComplete).toBe(allComplete);
    // The dashboard's welcome-view flag: the three data-creating items, with
    // the calculator deliberately left out of the conjunction.
    expect(result.coreComplete).toBe(signals[0] && signals[2] && signals[3]);
  });

  it('is coreComplete without the calculator — the one aside must not hold the dashboard', () => {
    const result = deriveChecklist(inputFor([true, false, true, true]));

    expect(result.coreComplete).toBe(true);
    expect(result.allComplete).toBe(false);
  });

  it('covers every combination of the four signals', () => {
    expect(table).toHaveLength(16);
    expect(new Set(table.map((row) => row.signals.join(','))).size).toBe(16);
  });

  it('is only allComplete when all four are — one gap is enough to keep it alive', () => {
    const complete = table.filter((row) => row.allComplete);

    expect(complete).toHaveLength(1);
    expect(complete[0].signals).toEqual([true, true, true, true]);
  });
});

describe('deriveChecklist — count derivation', () => {
  it('treats zero as incomplete and any positive count as complete', () => {
    expect(
      doneFlags({ accountCount: 0, positionsEverCreatedCount: 0, closedPositionCount: 0 }),
    ).toEqual([false, false, false, false]);
    expect(
      doneFlags({ accountCount: 1, positionsEverCreatedCount: 1, closedPositionCount: 1 }),
    ).toEqual([true, false, true, true]);
    expect(
      doneFlags({ accountCount: 3, positionsEverCreatedCount: 42, closedPositionCount: 17 }),
    ).toEqual([true, false, true, true]);
  });

  it('derives from the counts alone — provenance is not an input', () => {
    // Two users with identical counts: one typed every position in by hand, the
    // other imported a CSV. There is no field here that could tell them apart,
    // which is exactly the point — completion is reachable by any route.
    const counts = { accountCount: 1, positionsEverCreatedCount: 12, closedPositionCount: 12 };

    expect(deriveChecklist(counts)).toEqual(deriveChecklist({ ...counts }));
    expect(doneFlags(counts)).toEqual([true, false, true, true]);
  });

  it('does not gate an item on the ones before it — out-of-order states are valid', () => {
    // Closed positions but no account row: the items are independent, so item 4
    // ticks and item 1 does not. Representable, not an error.
    expect(
      doneFlags({ accountCount: 0, positionsEverCreatedCount: 5, closedPositionCount: 5 }),
    ).toEqual([false, false, true, true]);
  });

  it('keeps item 3 ticked once every position has been closed', () => {
    // positionsEverCreatedCount counts positions ever created, NOT open ones.
    // A user who has closed all 4 of their positions has still logged a
    // position, so item 3 stays ticked and the checklist can retire. If a caller
    // ever passed an open-only count here, this user would show 0 and item 3
    // would un-tick itself — the reason the field is named as it is.
    const allClosed = {
      accountCount: 1,
      positionsEverCreatedCount: 4,
      closedPositionCount: 4,
      calculatorFirstUsedAt: USED_AT,
    };

    expect(doneFlags(allClosed)).toEqual([true, true, true, true]);
    expect(deriveChecklist(allClosed).allComplete).toBe(true);
  });

  it('leaves item 1 incomplete while only demo data is present', () => {
    // Demo seeding is not creating an account, so the account count the caller
    // passes excludes it and item 1 stays open. Nothing in here needs to know
    // about demo data — it only ever sees the number it is given.
    expect(
      doneFlags({ accountCount: 0, positionsEverCreatedCount: 8, closedPositionCount: 4 })[0],
    ).toBe(false);
  });
});

describe('deriveChecklist — calculator timestamp (the one item with no rows behind it)', () => {
  const counts = { accountCount: 0, positionsEverCreatedCount: 0, closedPositionCount: 0 };

  it('is incomplete when the key is absent — the API omits it rather than nulling it', () => {
    expect(deriveChecklist(counts).items[1].done).toBe(false);
  });

  it('is incomplete for null and for an empty string', () => {
    expect(deriveChecklist({ ...counts, calculatorFirstUsedAt: null }).items[1].done).toBe(false);
    expect(deriveChecklist({ ...counts, calculatorFirstUsedAt: '' }).items[1].done).toBe(false);
  });

  it('is complete for any recorded timestamp', () => {
    expect(deriveChecklist({ ...counts, calculatorFirstUsedAt: USED_AT }).items[1].done).toBe(true);
    expect(
      deriveChecklist({ ...counts, calculatorFirstUsedAt: '2020-01-01T00:00:00.000Z' }).items[1]
        .done,
    ).toBe(true);
  });

  it('is complete for a malformed value too — forgiving on purpose', () => {
    // The stored value comes from a jsonb column, so junk is reachable. Item 2
    // asks only WHETHER the calculator was used, never WHEN, so any non-empty
    // string ticks it. Parsing strictly would strand the checklist on a bad
    // stored value the user has no way to clear. Pinned so the posture is a
    // decision, not an accident someone "fixes" later.
    for (const junk of ['not-a-date', '{}', '0', 'null', '   ']) {
      expect(deriveChecklist({ ...counts, calculatorFirstUsedAt: junk }).items[1].done).toBe(true);
    }
  });

  it('reads the timestamp only — no count moves item 2', () => {
    expect(
      deriveChecklist({ accountCount: 9, positionsEverCreatedCount: 9, closedPositionCount: 9 })
        .items[1].done,
    ).toBe(false);
  });

  it('is the only item the timestamp moves', () => {
    const withTimestamp = deriveChecklist({ ...counts, calculatorFirstUsedAt: USED_AT });

    expect(withTimestamp.items.map((item) => item.done)).toEqual([false, true, false, false]);
    expect(withTimestamp.allComplete).toBe(false);
  });
});

describe('deriveChecklist — nonsense counts stay harmless', () => {
  // The function is total: it validates nothing and throws nothing, because a
  // checklist is a nudge and bad input should degrade to an un-ticked item
  // rather than an error the user cannot get past. These tests pin that
  // behaviour so a later refactor cannot quietly turn it into a throw or a
  // silently-ticked item.

  it('treats a negative count as not positive', () => {
    expect(
      doneFlags({ accountCount: -1, positionsEverCreatedCount: -5, closedPositionCount: -1 }),
    ).toEqual([false, false, false, false]);
  });

  it('treats NaN as not positive', () => {
    expect(
      doneFlags({
        accountCount: Number.NaN,
        positionsEverCreatedCount: Number.NaN,
        closedPositionCount: Number.NaN,
      }),
    ).toEqual([false, false, false, false]);
  });

  it('accepts more closed positions than were ever created without complaint', () => {
    // Impossible in real data, but the two counts are read independently and
    // never compared, so this is representable rather than an error.
    expect(
      doneFlags({ accountCount: 1, positionsEverCreatedCount: 1, closedPositionCount: 9 }),
    ).toEqual([true, false, true, true]);
  });

  it('never throws on any of them', () => {
    expect(() =>
      deriveChecklist({
        accountCount: Number.NaN,
        positionsEverCreatedCount: -1,
        closedPositionCount: Number.POSITIVE_INFINITY,
      }),
    ).not.toThrow();
  });
});

describe('deriveChecklist — purity', () => {
  it('runs with no DOM at all', () => {
    // Pins the docblock at the top of this file. If someone drops the node
    // environment override, or the module starts reaching for a browser API,
    // this fails rather than silently passing under jsdom.
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');
  });

  it('does not mutate its input', () => {
    const input: ChecklistInput = {
      accountCount: 1,
      positionsEverCreatedCount: 1,
      closedPositionCount: 0,
      calculatorFirstUsedAt: USED_AT,
    };

    deriveChecklist(input);

    expect(input).toEqual({
      accountCount: 1,
      positionsEverCreatedCount: 1,
      closedPositionCount: 0,
      calculatorFirstUsedAt: USED_AT,
    });
  });

  it('returns an equal result for equal input, and a fresh array each call', () => {
    const input: ChecklistInput = {
      accountCount: 1,
      positionsEverCreatedCount: 0,
      closedPositionCount: 0,
    };
    const first = deriveChecklist(input);
    const second = deriveChecklist(input);

    expect(first).toEqual(second);
    expect(first.items).not.toBe(second.items);
  });
});

import { Decimal } from 'decimal.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { NormalizedRow } from './csv-normalize';
import { segment, type Segment } from './csv-segment';

// Mirror the global Decimal config (app.ts:82) so the signed-net walk matches
// production exactly.
beforeAll(() => {
  Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20 });
});

/** Build a normalized execution row. Quantities are 8-dp-quantized strings. */
function exec(values: Record<string, string>, sourceRow: number): NormalizedRow {
  return {
    sourceRow,
    values: { symbol: 'AAPL', assetType: 'stock', price: '100', ...values },
  };
}

function sides(segments: Segment[]): string[] {
  return segments.map((s) => s.side);
}

describe('segment — execution flat-boundary segmentation (REQ-4.2)', () => {
  it('a long round-trip becomes one closed segment (entry then exit)', () => {
    const rows = [
      exec({ action: 'buy', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ action: 'sell', quantity: '100', filledAt: '2024-01-01T11:00:00.000Z' }, 3),
    ];
    const { segments, errors, warnings } = segment(rows, 'execution');
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(segments).toHaveLength(1);
    expect(segments[0].side).toBe('long');
    expect(segments[0].closes).toBe(true);
    expect(segments[0].executions.map((e) => e.type)).toEqual(['entry', 'exit']);
    expect(segments[0].executions[0].sourceRow).toBe(2);
    expect(segments[0].executions[1].sourceRow).toBe(3);
  });

  it('splits two same-day round-trips into two segments', () => {
    const rows = [
      exec({ action: 'buy', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ action: 'sell', quantity: '100', filledAt: '2024-01-01T11:00:00.000Z' }, 3),
      exec({ action: 'buy', quantity: '50', filledAt: '2024-01-01T13:00:00.000Z' }, 4),
      exec({ action: 'sell', quantity: '50', filledAt: '2024-01-01T14:00:00.000Z' }, 5),
    ];
    const { segments, errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(0);
    expect(segments).toHaveLength(2);
    expect(segments[0].executions.map((e) => e.sourceRow)).toEqual([2, 3]);
    expect(segments[1].executions.map((e) => e.sourceRow)).toEqual([4, 5]);
    expect(segments.every((s) => s.closes)).toBe(true);
  });

  it('handles long → flat → short (signed-net direction flips per segment)', () => {
    const rows = [
      exec({ action: 'buy', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ action: 'sell', quantity: '100', filledAt: '2024-01-01T11:00:00.000Z' }, 3),
      exec({ action: 'sell', quantity: '40', filledAt: '2024-01-01T12:00:00.000Z' }, 4),
      exec({ action: 'buy', quantity: '40', filledAt: '2024-01-01T13:00:00.000Z' }, 5),
    ];
    const { segments, errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(0);
    expect(segments).toHaveLength(2);
    expect(sides(segments)).toEqual(['long', 'short']);
    expect(segments[1].executions.map((e) => e.type)).toEqual(['entry', 'exit']);
    expect(segments.every((s) => s.closes)).toBe(true);
  });

  it('scopes by (symbol, assetType): different symbols are separate positions', () => {
    const rows = [
      exec(
        { symbol: 'AAPL', action: 'buy', quantity: '10', filledAt: '2024-01-01T10:00:00.000Z' },
        2,
      ),
      exec(
        { symbol: 'MSFT', action: 'buy', quantity: '5', filledAt: '2024-01-01T10:30:00.000Z' },
        3,
      ),
      exec(
        { symbol: 'AAPL', action: 'sell', quantity: '10', filledAt: '2024-01-01T11:00:00.000Z' },
        4,
      ),
      exec(
        { symbol: 'MSFT', action: 'sell', quantity: '5', filledAt: '2024-01-01T11:30:00.000Z' },
        5,
      ),
    ];
    const { segments, errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(0);
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.scope.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('orders by filledAt within a scope even when source rows are shuffled', () => {
    const rows = [
      exec({ action: 'sell', quantity: '100', filledAt: '2024-01-01T11:00:00.000Z' }, 2),
      exec({ action: 'buy', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 3),
    ];
    const { segments, errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(0);
    expect(segments).toHaveLength(1);
    // Earliest filledAt (the buy, row 3) is the entry.
    expect(segments[0].executions[0].sourceRow).toBe(3);
    expect(segments[0].executions[0].type).toBe('entry');
    expect(segments[0].side).toBe('long');
  });
});

describe('segment — crossing flat (REQ-4.2)', () => {
  it('an exit larger than the open quantity is a located error (no auto-flip)', () => {
    const rows = [
      exec({ action: 'buy', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ action: 'sell', quantity: '150', filledAt: '2024-01-01T11:00:00.000Z' }, 3),
    ];
    const { errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('SEGMENT_CROSSES_FLAT');
    expect(errors[0].rowNumber).toBe(3);
  });
});

describe('segment — residual non-flat (REQ-4.5)', () => {
  it('a scope that never returns to flat imports a trailing closes:false segment', () => {
    const rows = [
      exec({ action: 'buy', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ action: 'sell', quantity: '40', filledAt: '2024-01-01T11:00:00.000Z' }, 3),
    ];
    const { segments, errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(0);
    expect(segments).toHaveLength(1);
    expect(segments[0].closes).toBe(false);
    expect(segments[0].executions.map((e) => e.type)).toEqual(['entry', 'exit']);
  });

  it('does not round a tiny residual to flat (8-dp quantities are exact)', () => {
    const rows = [
      exec({ action: 'buy', quantity: '100.00000001', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ action: 'sell', quantity: '100', filledAt: '2024-01-01T11:00:00.000Z' }, 3),
    ];
    const { segments, errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(0);
    expect(segments).toHaveLength(1);
    expect(segments[0].closes).toBe(false);
  });
});

describe('segment — same-instant direction guard + warning (REQ-4.2)', () => {
  it('warns when direction was inferred from row order among same-instant fills', () => {
    // Two same-instant fills with NO disambiguating signal beyond side.
    const rows = [
      exec({ side: 'long', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ side: 'long', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 3),
    ];
    // side-only with no action/type → both look like entries on |net|, residual.
    const { warnings } = segment(rows, 'execution');
    expect(warnings.some((w) => w.kind === 'direction_inferred')).toBe(true);
  });

  it('does NOT warn when explicit type/action disambiguates same-instant fills', () => {
    const rows = [
      exec({ action: 'buy', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ action: 'sell', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 3),
    ];
    const { segments, warnings, errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(0);
    expect(warnings.filter((w) => w.kind === 'direction_inferred')).toHaveLength(0);
    // The explicit buy sorts before the explicit sell at the same instant.
    expect(segments[0].executions.map((e) => e.type)).toEqual(['entry', 'exit']);
  });
});

describe('segment — explicit-type/side contradiction (REQ-4.3)', () => {
  it('explicit type contradicting the running net is a located error', () => {
    const rows = [
      // Opening buy declared as an "exit" — contradicts the net (it is an entry).
      exec(
        { action: 'buy', type: 'exit', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' },
        2,
      ),
    ];
    const { errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('SEGMENT_TYPE_CONTRADICTION');
    expect(errors[0].rowNumber).toBe(2);
  });

  it('explicit side contradicting the inferred segment direction is a located error', () => {
    const rows = [
      // Opening buy (long) declared side "short".
      exec(
        { action: 'buy', side: 'short', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' },
        2,
      ),
    ];
    const { errors } = segment(rows, 'execution');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('SEGMENT_SIDE_CONTRADICTION');
  });
});

describe('segment — timestamps (REQ-4.5)', () => {
  it('openedAt-equivalent first exec ≤ closedAt-equivalent last exec', () => {
    const rows = [
      exec({ action: 'buy', quantity: '100', filledAt: '2024-01-01T10:00:00.000Z' }, 2),
      exec({ action: 'sell', quantity: '100', filledAt: '2024-01-01T11:00:00.000Z' }, 3),
    ];
    const { segments } = segment(rows, 'execution');
    const ex = segments[0].executions;
    expect(ex[0].filledAt <= ex[ex.length - 1].filledAt).toBe(true);
  });
});

describe('segment — round-trip rows (REQ-4.1, manual-mapping fixture)', () => {
  it('each round-trip row becomes one closed segment with one entry + one exit', () => {
    const rows: NormalizedRow[] = [
      {
        sourceRow: 2,
        values: {
          symbol: 'AAPL',
          assetType: 'stock',
          side: 'long',
          entryPrice: '100',
          entryQuantity: '10',
          entryDate: '2024-01-01T00:00:00.000Z',
          exitPrice: '110',
          exitQuantity: '10',
          exitDate: '2024-01-02T00:00:00.000Z',
        },
      },
      {
        sourceRow: 3,
        values: {
          symbol: 'TSLA',
          assetType: 'stock',
          side: 'short',
          entryPrice: '200',
          entryQuantity: '5',
          entryDate: '2024-01-03T00:00:00.000Z',
          exitPrice: '190',
          exitQuantity: '5',
          exitDate: '2024-01-04T00:00:00.000Z',
        },
      },
    ];
    const { segments, errors, warnings } = segment(rows, 'round-trip');
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(segments).toHaveLength(2);
    // No cross-row merging: one segment per row.
    expect(segments[0].scope.symbol).toBe('AAPL');
    expect(segments[0].side).toBe('long');
    expect(segments[0].closes).toBe(true);
    expect(segments[0].executions.map((e) => e.type)).toEqual(['entry', 'exit']);
    expect(segments[0].executions[0].price).toBe('100');
    expect(segments[0].executions[1].price).toBe('110');
    expect(segments[1].scope.symbol).toBe('TSLA');
    expect(segments[1].side).toBe('short');
  });
});

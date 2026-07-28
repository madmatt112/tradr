import { describe, it, expect } from 'vitest';

import {
  exitWouldExceedEntry,
  hasAtLeastOneEntry,
  reconciles,
  closeNotBeforeOpen,
  isWholeContracts,
  validateSegmentInvariants,
} from './segment-invariants';
import type { InMemoryFill } from './segment-invariants';

// ---------------------------------------------------------------------------
// Granular predicates
// ---------------------------------------------------------------------------

describe('exitWouldExceedEntry', () => {
  it('is true when new exit total surpasses entry total', () => {
    expect(exitWouldExceedEntry('100', '60', '50')).toBe(true);
  });
  it('is false at exact reconciliation', () => {
    expect(exitWouldExceedEntry('100', '60', '40')).toBe(false);
  });
  it('is false below entry total', () => {
    expect(exitWouldExceedEntry('100', '0', '30')).toBe(false);
  });
  it('compares by decimal value, not string', () => {
    expect(exitWouldExceedEntry('100.00000000', '99.5', '0.5')).toBe(false);
    expect(exitWouldExceedEntry('100', '100', '0.00000001')).toBe(true);
  });
});

describe('hasAtLeastOneEntry', () => {
  it('is false for zero', () => {
    expect(hasAtLeastOneEntry(0)).toBe(false);
  });
  it('is true for one or more', () => {
    expect(hasAtLeastOneEntry(1)).toBe(true);
    expect(hasAtLeastOneEntry(5)).toBe(true);
  });
});

describe('reconciles (decimal-equal — safe widening)', () => {
  it('reconciles equal same-format totals', () => {
    expect(reconciles('100', '100')).toBe(true);
  });
  it('does not reconcile unequal totals', () => {
    expect(reconciles('100', '99')).toBe(false);
  });
  // Round-2 SF-B regression: the live string `!==` check would have rejected
  // this; decimal-equal accepts it. Proves the deliberate safe widening.
  it('reconciles mismatched-precision totals ("100" vs "100.00000000")', () => {
    expect(reconciles('100', '100.00000000')).toBe(true);
    expect(reconciles('100.00000000', '100')).toBe(true);
  });
  it('reconciles sums of differently-scaled strings', () => {
    expect(reconciles('33.33333333', '33.330000000000')).toBe(false);
    expect(reconciles('0.50', '0.5')).toBe(true);
  });
});

describe('closeNotBeforeOpen', () => {
  it('is true when openedAt is null', () => {
    expect(closeNotBeforeOpen(null, '2024-01-01T00:00:00Z')).toBe(true);
  });
  it('is true when close equals open', () => {
    expect(closeNotBeforeOpen('2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')).toBe(true);
  });
  it('is true when close is after open', () => {
    expect(closeNotBeforeOpen('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z')).toBe(true);
  });
  it('is false when close precedes open', () => {
    expect(closeNotBeforeOpen('2024-01-02T00:00:00Z', '2024-01-01T00:00:00Z')).toBe(false);
  });
  it('accepts Date instances', () => {
    expect(closeNotBeforeOpen(new Date('2024-01-01'), new Date('2024-01-02'))).toBe(true);
  });
});

describe('isWholeContracts', () => {
  it('is true for an integer quantity', () => {
    expect(isWholeContracts('5')).toBe(true);
    expect(isWholeContracts('5.00000000')).toBe(true);
  });
  it('is false for a fractional quantity', () => {
    expect(isWholeContracts('5.5')).toBe(false);
    expect(isWholeContracts('0.00000001')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composite: validateSegmentInvariants
// ---------------------------------------------------------------------------

function entry(quantity: string, filledAt?: string): InMemoryFill {
  return { type: 'entry', quantity, filledAt };
}
function exit(quantity: string, filledAt?: string): InMemoryFill {
  return { type: 'exit', quantity, filledAt };
}

describe('validateSegmentInvariants', () => {
  it('passes a clean closed stock segment', () => {
    const errors = validateSegmentInvariants([entry('100'), exit('100')], {
      assetType: 'stock',
      closes: true,
    });
    expect(errors).toEqual([]);
  });

  it('passes a clean open (residual) stock segment', () => {
    const errors = validateSegmentInvariants([entry('100'), exit('40')], {
      assetType: 'stock',
      closes: false,
    });
    expect(errors).toEqual([]);
  });

  it('passes the same-instant interleave (preview/commit ordering identity)', () => {
    // entry 100, exit 60, entry 50, exit 90 → net flat, never exceeds entry.
    const errors = validateSegmentInvariants([entry('100'), exit('60'), entry('50'), exit('90')], {
      assetType: 'stock',
      closes: true,
    });
    expect(errors).toEqual([]);
  });

  it('flags an exit that exceeds the running entry total', () => {
    const errors = validateSegmentInvariants([entry('100'), exit('150')], {
      assetType: 'stock',
      closes: false,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('EXIT_EXCEEDS_ENTRY');
    expect(errors[0].fillIndex).toBe(1);
  });

  it('flags an exit before any entry', () => {
    const errors = validateSegmentInvariants([exit('10'), entry('10')], {
      assetType: 'stock',
      closes: false,
    });
    expect(errors.some((e) => e.code === 'EXIT_BEFORE_ENTRY')).toBe(true);
  });

  it('flags a whole-segment reconciliation residual and names it', () => {
    const errors = validateSegmentInvariants([entry('100'), exit('40')], {
      assetType: 'stock',
      closes: true,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('SEGMENT_NOT_RECONCILED');
    expect(errors[0].fillIndex).toBeNull();
    expect(errors[0].residual).toBe('60');
  });

  it('reconciles a closed segment with mismatched-precision quantities', () => {
    const errors = validateSegmentInvariants([entry('100'), exit('100.00000000')], {
      assetType: 'stock',
      closes: true,
    });
    expect(errors).toEqual([]);
  });

  it('flags a fractional option quantity', () => {
    const errors = validateSegmentInvariants([entry('5.5'), exit('5.5')], {
      assetType: 'option',
      closes: true,
    });
    expect(errors.filter((e) => e.code === 'OPTION_FRACTIONAL_QUANTITY')).toHaveLength(2);
  });

  it('allows whole-number option quantities', () => {
    const errors = validateSegmentInvariants([entry('5'), exit('5')], {
      assetType: 'option',
      closes: true,
    });
    expect(errors).toEqual([]);
  });

  it('flags a close timestamp before the open timestamp', () => {
    const errors = validateSegmentInvariants([entry('10'), exit('10')], {
      assetType: 'stock',
      closes: true,
      openedAt: '2024-01-02T00:00:00Z',
      closedAt: '2024-01-01T00:00:00Z',
    });
    expect(errors.some((e) => e.code === 'CLOSE_BEFORE_OPEN')).toBe(true);
  });

  it('does not run close checks for an open segment', () => {
    const errors = validateSegmentInvariants([entry('100'), exit('40')], {
      assetType: 'stock',
      closes: false,
      openedAt: '2024-01-02T00:00:00Z',
      closedAt: '2024-01-01T00:00:00Z',
    });
    expect(errors).toEqual([]);
  });
});

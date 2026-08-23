import { describe, expect, it } from 'vitest';

import { formatFillDate, positionAgeDays } from './positionAge';

const NOW = new Date('2026-08-23T12:00:00.000Z');

describe('positionAgeDays', () => {
  it('is the whole days from open to now for a live position', () => {
    expect(positionAgeDays('2026-07-06T12:00:00.000Z', null, NOW)).toBe(48);
  });

  it('freezes at close for a closed position', () => {
    expect(positionAgeDays('2026-07-01T00:00:00.000Z', '2026-07-31T00:00:00.000Z', NOW)).toBe(30);
  });

  it('is null for a draft that never opened', () => {
    expect(positionAgeDays(null, null, NOW)).toBeNull();
  });

  it('floors part-days and never goes negative', () => {
    expect(positionAgeDays('2026-08-23T01:00:00.000Z', null, NOW)).toBe(0);
    // A clock skew putting openedAt in the future still reads 0, not -1.
    expect(positionAgeDays('2026-08-24T00:00:00.000Z', null, NOW)).toBe(0);
  });

  it('is null for an unparseable timestamp', () => {
    expect(positionAgeDays('not-a-date', null, NOW)).toBeNull();
  });
});

describe('formatFillDate', () => {
  it('renders the compact ledger date', () => {
    expect(formatFillDate('2026-07-04T14:30:00.000Z')).toMatch(/^Jul 4$/);
  });

  it('degrades to an em-dash on garbage', () => {
    expect(formatFillDate('nope')).toBe('—');
  });
});

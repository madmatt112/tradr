// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { PositionListItemSchema } from '@tradr/shared';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

describe('test setup smoke', () => {
  it('window.matchMedia returns a shim with a callable addEventListener', () => {
    const mql = window.matchMedia('(min-width: 1px)');
    expect(typeof mql.addEventListener).toBe('function');
    expect(() => mql.addEventListener('change', () => {})).not.toThrow();
  });

  it('PositionListItemSchema accepts the default makePosition() fixture', () => {
    expect(() => PositionListItemSchema.parse(makePosition())).not.toThrow();
  });
});

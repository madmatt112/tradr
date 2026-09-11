// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CSV_IMPORT_PRESETS, type Mapping } from '@tradr/shared';

import { isRequiredFieldSatisfied, targetFieldsForShape } from './fields';

const COMPOSED_FIELDS = [
  { field: 'underlying', label: 'Underlying (options; defaults to Symbol)', required: false },
  { field: 'expiry', label: 'Expiry (options)', required: false },
  { field: 'strike', label: 'Strike (options)', required: false },
  { field: 'right', label: 'Call/Put (options)', required: false },
];

describe('targetFieldsForShape', () => {
  it('appends the four optional contract fields for execution + composed', () => {
    const base = targetFieldsForShape('execution');
    const composed = targetFieldsForShape('execution', 'composed');
    expect(composed.slice(0, base.length)).toEqual(base);
    expect(composed.slice(base.length)).toEqual(COMPOSED_FIELDS);
  });

  it('lists only the descriptor field for execution + descriptor', () => {
    const base = targetFieldsForShape('execution');
    const descriptor = targetFieldsForShape('execution', 'descriptor');
    expect(descriptor.slice(0, base.length)).toEqual(base);
    expect(descriptor.slice(base.length)).toEqual([
      { field: 'descriptor', label: 'Option descriptor (set by preset)', required: false },
    ]);
  });

  it('equals the base list for execution + occ-symbol and execution + undefined', () => {
    const base = targetFieldsForShape('execution');
    expect(targetFieldsForShape('execution', 'occ-symbol')).toEqual(base);
    expect(targetFieldsForShape('execution', undefined)).toEqual(base);
  });

  it('appends the four optional contract fields for round-trip + composed', () => {
    const base = targetFieldsForShape('round-trip');
    const composed = targetFieldsForShape('round-trip', 'composed');
    expect(composed.slice(0, base.length)).toEqual(base);
    expect(composed.slice(base.length)).toEqual(COMPOSED_FIELDS);
  });
});

describe('isRequiredFieldSatisfied', () => {
  const tradervue = CSV_IMPORT_PRESETS.find((p) => p.id === 'tradervue')!;

  it('exempts assetType under the shipped tradervue preset (descriptor form)', () => {
    expect(isRequiredFieldSatisfied('assetType', tradervue.mapping)).toBe(true);
  });

  it('does not exempt assetType once the descriptor column is removed', () => {
    const withoutDescriptor: Mapping = {
      ...tradervue.mapping,
      columns: Object.fromEntries(
        Object.entries(tradervue.mapping.columns).filter(([key]) => key !== 'descriptor'),
      ),
    };
    expect(isRequiredFieldSatisfied('assetType', withoutDescriptor)).toBe(false);
  });

  it('follows columns[field] for a non-exempt field', () => {
    expect(isRequiredFieldSatisfied('symbol', tradervue.mapping)).toBe(true);
    const withoutSymbol: Mapping = {
      ...tradervue.mapping,
      columns: { ...tradervue.mapping.columns, symbol: '' },
    };
    expect(isRequiredFieldSatisfied('symbol', withoutSymbol)).toBe(false);
  });
});

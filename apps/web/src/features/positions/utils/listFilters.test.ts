// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { positionsListQuery } from '../hooks/usePositions';

import { buildListFilters } from './listFilters';

// Two well-formed UUIDs, `A` sorting before `B` lexicographically.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('buildListFilters', () => {
  it('returns undefined for garbage-only tag with no status', () => {
    expect(buildListFilters({ tag: 'abc,def' })).toBeUndefined();
  });

  it('returns undefined for empty search', () => {
    expect(buildListFilters({})).toBeUndefined();
  });

  it('keeps a single valid id', () => {
    expect(buildListFilters({ tag: A })).toStrictEqual({ tag: [A] });
  });

  it('sorts the ids so b,a and a,b produce one identical array', () => {
    const ba = buildListFilters({ tag: `${B},${A}` });
    const ab = buildListFilters({ tag: `${A},${B}` });
    expect(ba?.tag).toEqual([A, B]);
    expect(ba).toStrictEqual(ab);
  });

  it('returns status alone with no tag key', () => {
    const result = buildListFilters({ status: 'open' });
    expect(result).toStrictEqual({ status: 'open' });
    expect(result).not.toHaveProperty('tag');
  });

  it('returns both status and tag when both are present', () => {
    expect(buildListFilters({ status: 'open', tag: A })).toStrictEqual({
      status: 'open',
      tag: [A],
    });
  });

  it('drops garbage but keeps the uuid', () => {
    expect(buildListFilters({ tag: `abc,${A}` })).toStrictEqual({ tag: [A] });
  });
});

describe('positionsListQuery key coupling', () => {
  it('keys the no-filter call ["positions", "list", undefined]', () => {
    expect(positionsListQuery(buildListFilters({})).queryKey).toEqual([
      'positions',
      'list',
      undefined,
    ]);
  });

  it('keys tag-only, tag+status and status-only calls differently', () => {
    const tagOnly = positionsListQuery({ tag: [A, B] }).queryKey;
    const tagAndStatus = positionsListQuery({ tag: [A, B], status: 'open' }).queryKey;
    const statusOnly = positionsListQuery({ status: 'open' }).queryKey;
    expect(tagOnly).not.toEqual(tagAndStatus);
    expect(tagOnly).not.toEqual(statusOnly);
    expect(tagAndStatus).not.toEqual(statusOnly);
  });
});

import { parseTagIdList } from '@tradr/shared/schemas/tag';

/**
 * Build the positions-list filter object from raw URL search values.
 *
 * `tag` is parsed through the shared `parseTagIdList`, so garbage elements are
 * dropped, duplicates collapse and the survivors come back sorted — that sort is
 * what lets `a,b` and `b,a` share one `positionsListQuery` cache entry (REQ-3.6).
 *
 * Returns the literal `undefined` when nothing is filtered, so the no-filter call
 * keys `['positions', 'list', undefined]` — the walkthrough coupling
 * (`useWalkthrough.ts`) depends on that exact key. Otherwise it returns an object
 * that carries `status` only when set, `tag` only when non-empty, and
 * `classification` only when set; never a key with an `undefined` value.
 */
export function buildListFilters(search: {
  status?: string;
  tag?: string;
  classification?: string;
}): { status?: string; tag?: string[]; classification?: string } | undefined {
  const { status, classification } = search;
  const tag = parseTagIdList(search.tag);
  if (!status && tag.length === 0 && !classification) return undefined;
  return {
    ...(status && { status }),
    ...(tag.length && { tag }),
    ...(classification && { classification }),
  };
}

import { canonicalDefinition } from '@tradr/shared/lib/trading-rules';
import type { TradingRuleDefinition } from '@tradr/shared/schemas/trading-rule';

// The dedup fingerprint of a rule (design C3a, D4). `ruleDedupKey` is stored in
// `trading_rules.dedup_key`; the unique index on `(user_id, dedup_key)` makes an
// exact duplicate a `23505` rather than a race.
//
// The key is `type|accountId|tagId|canonical params JSON`. "No scope" is its own
// value (`-`), so a global rule and an account-scoped rule with equal type,
// currency and parameters never collide. The currency lives inside the params
// (D3), so it is part of the key. The definition is canonicalised first, so
// `2.50` and `2.5`, and two set members in either order, collapse to one key.
export function ruleDedupKey(
  definition: TradingRuleDefinition,
  accountId: string | null,
  tagId: string | null,
): string {
  const canonical = canonicalDefinition(definition);
  return [canonical.type, accountId ?? '-', tagId ?? '-', JSON.stringify(canonical.params)].join(
    '|',
  );
}

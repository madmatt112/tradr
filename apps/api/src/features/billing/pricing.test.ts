import { describe, expect, it } from 'vitest';

import { config } from '@/lib/config';

import {
  PLATFORM_DEFAULT_MODEL,
  RATE_TABLE,
  UnpricedModelError,
  isModelPriced,
  priceTurnUsage,
  priceTurnUsageParts,
} from './pricing';

// These tests assume the default markup '1.2' (12/10). config.PRICING_MARKUP is
// not overridden in the test env, so it should be the default; assert it so a
// changed default fails loudly here rather than silently skewing expectations.
describe('pricing config assumption', () => {
  it('uses the default 1.2 markup', () => {
    expect(config.PRICING_MARKUP).toBe('1.2');
  });
});

describe('isModelPriced', () => {
  it('is true for a priced model', () => {
    expect(isModelPriced('claude', 'claude-opus-4-7')).toBe(true);
    expect(isModelPriced('openai', 'gpt-4o')).toBe(true);
  });

  it('is false for an unpriced model on a known provider', () => {
    expect(isModelPriced('claude', 'claude-some-future-model')).toBe(false);
    expect(isModelPriced('openai', 'gpt-5-ultra')).toBe(false);
  });

  it('is false for an empty model id', () => {
    expect(isModelPriced('claude', '')).toBe(false);
  });
});

describe('PLATFORM_DEFAULT_MODEL', () => {
  it('every default is itself a priced model in RATE_TABLE', () => {
    const entries = Object.entries(PLATFORM_DEFAULT_MODEL) as ['claude' | 'openai', string][];
    expect(entries.length).toBeGreaterThan(0);
    for (const [provider, def] of entries) {
      expect(isModelPriced(provider, def)).toBe(true);
      expect(RATE_TABLE[provider][def]).toBeDefined();
    }
  });

  it('BYOK-only providers have no platform default and an empty priced set', () => {
    for (const provider of ['gemini', 'openrouter'] as const) {
      expect(PLATFORM_DEFAULT_MODEL[provider]).toBeUndefined();
      expect(Object.keys(RATE_TABLE[provider])).toHaveLength(0);
      expect(isModelPriced(provider, 'anything')).toBe(false);
    }
  });
});

describe('priceTurnUsage — known token counts → known credit cost', () => {
  it('prices gpt-4o (3 in / 10 out micro-USD per token) with 1.2 markup', () => {
    // raw = 1000*3 + 1000*10 = 13000; *12/10 = 15600 (exact, no rounding)
    const cost = priceTurnUsage({
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(cost).toBe(15600n);
    expect(typeof cost).toBe('bigint');
  });

  it('prices claude-opus-4-7 (15 in / 75 out)', () => {
    // raw = 200*15 + 100*75 = 3000 + 7500 = 10500; *12/10 = 12600 (exact)
    const cost = priceTurnUsage({
      provider: 'claude',
      model: 'claude-opus-4-7',
      inputTokens: 200,
      outputTokens: 100,
    });
    expect(cost).toBe(12600n);
  });

  it('returns 0 for a zero-token turn', () => {
    expect(
      priceTurnUsage({ provider: 'openai', model: 'gpt-4o', inputTokens: 0, outputTokens: 0 }),
    ).toBe(0n);
  });

  it('accepts bigint token counts', () => {
    const cost = priceTurnUsage({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 10n,
      outputTokens: 0n,
    });
    // raw = 10*1 = 10; *12/10 = 12 (exact)
    expect(cost).toBe(12n);
  });
});

describe('priceTurnUsage — markup + ceil rounding edges (never under-charge)', () => {
  // gpt-4o-mini is 1 in / 1 out micro-USD per token, so raw cost == total tokens,
  // making the markup-rounding behaviour easy to pin exactly.
  const mini = (inputTokens: number, outputTokens: number) =>
    priceTurnUsage({ provider: 'openai', model: 'gpt-4o-mini', inputTokens, outputTokens });

  it('raw=1 → ceil(1.2) = 2 (rounds up on remainder)', () => {
    expect(mini(1, 0)).toBe(2n);
  });

  it('raw=4 → ceil(4.8) = 5 (rounds up)', () => {
    expect(mini(4, 0)).toBe(5n);
  });

  it('raw=5 → 6.0 exact, no extra +1', () => {
    expect(mini(5, 0)).toBe(6n);
  });

  it('raw=10 → 12.0 exact', () => {
    expect(mini(10, 0)).toBe(12n);
  });

  it('raw=15 → ceil(18.0) = 18 exact (half-token internal product, still integer)', () => {
    // 15*12 = 180; 180/10 = 18 exact
    expect(mini(15, 0)).toBe(18n);
  });

  it('raw=7 → ceil(8.4) = 9 (rounds up the remainder)', () => {
    expect(mini(7, 0)).toBe(9n);
  });

  it('every +1 raw token is monotonic non-decreasing', () => {
    let prev = 0n;
    for (let t = 0; t <= 50; t++) {
      const c = mini(t, 0);
      expect(c >= prev).toBe(true);
      prev = c;
    }
  });
});

describe('priceTurnUsage — unpriced model is refused without crashing the caller', () => {
  it('throws UnpricedModelError for an unpriced model', () => {
    expect(() =>
      priceTurnUsage({
        provider: 'claude',
        model: 'claude-not-priced',
        inputTokens: 100,
        outputTokens: 100,
      }),
    ).toThrow(UnpricedModelError);
  });

  it('a caller can gate via isModelPriced to avoid the throw entirely (REQ-5.6)', () => {
    const provider = 'openai' as const;
    const model = 'gpt-unlisted';
    // Pattern callers use: check priced first, only then meter.
    const charge = isModelPriced(provider, model)
      ? priceTurnUsage({ provider, model, inputTokens: 1, outputTokens: 1 })
      : null;
    expect(charge).toBeNull();
  });

  it('rejects negative token counts', () => {
    expect(() =>
      priceTurnUsage({ provider: 'openai', model: 'gpt-4o', inputTokens: -1, outputTokens: 0 }),
    ).toThrow();
  });
});

describe('priceTurnUsageParts — raw/credit parity with priceTurnUsage (admin-platform REQ-4.2)', () => {
  // The existing fixture matrix, restated as (provider, model, in, out) tuples
  // with their pinned expectations — including the rounding edges.
  const fixtures = [
    // Known token counts → known cost.
    { provider: 'openai', model: 'gpt-4o', input: 1000, output: 1000, raw: 13000n, credit: 15600n },
    {
      provider: 'claude',
      model: 'claude-opus-4-7',
      input: 200,
      output: 100,
      raw: 10500n,
      credit: 12600n,
    },
    { provider: 'openai', model: 'gpt-4o', input: 0, output: 0, raw: 0n, credit: 0n },
    { provider: 'openai', model: 'gpt-4o-mini', input: 10, output: 0, raw: 10n, credit: 12n },
    // Markup + ceil rounding edges (gpt-4o-mini: raw == total tokens).
    { provider: 'openai', model: 'gpt-4o-mini', input: 1, output: 0, raw: 1n, credit: 2n },
    { provider: 'openai', model: 'gpt-4o-mini', input: 4, output: 0, raw: 4n, credit: 5n },
    { provider: 'openai', model: 'gpt-4o-mini', input: 5, output: 0, raw: 5n, credit: 6n },
    { provider: 'openai', model: 'gpt-4o-mini', input: 15, output: 0, raw: 15n, credit: 18n },
    { provider: 'openai', model: 'gpt-4o-mini', input: 7, output: 0, raw: 7n, credit: 9n },
    // Sub-micro-USD model with rounded-up input rate (Haiku in=1, out=4).
    {
      provider: 'claude',
      model: 'claude-haiku-3-5',
      input: 333,
      output: 77,
      raw: 641n,
      credit: 770n, // ceil(641 * 12 / 10) = ceil(769.2)
    },
  ] as const;

  it.each(fixtures)(
    '$provider/$model in=$input out=$output → raw=$raw credit=$credit, creditCost === priceTurnUsage',
    ({ provider, model, input, output, raw, credit }) => {
      const args = { provider, model, inputTokens: input, outputTokens: output };
      const parts = priceTurnUsageParts(args);
      expect(parts.rawCost).toBe(raw);
      expect(parts.creditCost).toBe(credit);
      // Byte-identical charged amount: priceTurnUsage delegates here.
      expect(parts.creditCost).toBe(priceTurnUsage(args));
    },
  );

  it('parity holds across every raw value 0..50 (incl. all markup remainders)', () => {
    for (let t = 0; t <= 50; t++) {
      const args = {
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputTokens: t,
        outputTokens: 0,
      } as const;
      const parts = priceTurnUsageParts(args);
      expect(parts.rawCost).toBe(BigInt(t));
      expect(parts.creditCost).toBe(priceTurnUsage(args));
    }
  });

  it('accepts bigint token counts like priceTurnUsage does', () => {
    const args = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 10n,
      outputTokens: 0n,
    } as const;
    expect(priceTurnUsageParts(args)).toEqual({ rawCost: 10n, creditCost: 12n });
  });

  it('throws UnpricedModelError for an unpriced model (identical validation)', () => {
    expect(() =>
      priceTurnUsageParts({
        provider: 'claude',
        model: 'claude-not-priced',
        inputTokens: 100,
        outputTokens: 100,
      }),
    ).toThrow(UnpricedModelError);
  });

  it('rejects negative token counts (identical validation)', () => {
    expect(() =>
      priceTurnUsageParts({
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: -1,
        outputTokens: 0,
      }),
    ).toThrow();
  });
});

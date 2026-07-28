import type { ProviderId } from '@tradr/shared';

import { config } from '@/lib/config';

/**
 * Pure pricing module (design Component 3, REQ-1.3/5.1/5.6/6.1).
 *
 * Credit unit: 1 credit = 1 micro-USD ($0.000001). All money arithmetic is
 * integer/bigint — never JS float — and rounds UP (ceil) so Tradr never
 * under-charges itself on rounding.
 *
 * No I/O, no DB. The only external read is `config.PRICING_MARKUP` (a decimal
 * string parsed once into an integer numerator/denominator fraction).
 */

/** Per-token rate in micro-USD (1 credit). Derived from public per-million-token USD pricing: `usdPerMillion` micro-USD per token == `usdPerMillion` (since $X/1e6 tokens = X micro-USD/token). */
export interface ModelRate {
  /** micro-USD charged per input token. */
  readonly inputMicroUsdPerToken: bigint;
  /** micro-USD charged per output token. */
  readonly outputMicroUsdPerToken: bigint;
}

/**
 * The priced set — the AUTHORITY for which models platform mode admits
 * (REQ-6.1). The advisor may list more models than are priced; only models
 * present here can be billed. Rates are pre-markup (raw provider cost); the
 * `PRICING_MARKUP` multiplier is applied in `priceTurnUsage`.
 *
 * Rates below mirror published per-million-token list prices (USD) as of 2026:
 *   $X per 1M tokens  ⇒  X micro-USD per token.
 */
export const RATE_TABLE: Record<ProviderId, Record<string, ModelRate>> = {
  claude: {
    // Claude Opus 4.x — $15 / $75 per 1M in/out.
    'claude-opus-4-7': { inputMicroUsdPerToken: 15n, outputMicroUsdPerToken: 75n },
    // Claude Sonnet 4.x — $3 / $15 per 1M in/out.
    'claude-sonnet-4-5': { inputMicroUsdPerToken: 3n, outputMicroUsdPerToken: 15n },
    // Claude Haiku 3.5 — $0.80 / $4 per 1M in/out → 0.8 / 4 micro-USD per token.
    // Sub-credit input rates are not representable in whole micro-USD per token;
    // Haiku input is rounded UP to 1 micro-USD/token (never under-charge).
    'claude-haiku-3-5': { inputMicroUsdPerToken: 1n, outputMicroUsdPerToken: 4n },
  },
  openai: {
    // GPT-4o — $2.50 / $10 per 1M in/out. Input 2.5 → rounded UP to 3 micro-USD/token.
    'gpt-4o': { inputMicroUsdPerToken: 3n, outputMicroUsdPerToken: 10n },
    // GPT-4o mini — $0.15 / $0.60 per 1M in/out → both round UP to 1 micro-USD/token.
    'gpt-4o-mini': { inputMicroUsdPerToken: 1n, outputMicroUsdPerToken: 1n },
  },
  // BYOK-only providers (v6): no platform keys exist for them
  // (getPlatformApiKey → undefined), so platform mode never admits their
  // models — the empty priced set documents that, it is not an omission.
  gemini: {},
  openrouter: {},
};

/**
 * Default priced model per provider — used ONLY for the existing-conversation
 * unpriced-model fallback (Component 5, REQ-4.4), NOT as a new-conversation
 * default. Each value MUST be a key present in `RATE_TABLE[provider]`.
 * Partial (v6): BYOK-only providers have no priced set and therefore no
 * default — platform mode is unreachable for them, so the fallback never fires.
 */
export const PLATFORM_DEFAULT_MODEL: Partial<Record<ProviderId, string>> = {
  claude: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
};

/**
 * Thrown by `priceTurnUsage` when asked to price a model that is not in the
 * priced set. Callers MUST gate via `isModelPriced` before metering (REQ-5.6),
 * so this never crashes the metering path in normal operation; it is a
 * defensive sentinel for a programming error (a turn reaching pricing unpriced).
 */
export class UnpricedModelError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly model: string,
  ) {
    super(`No price for model '${model}' on provider '${provider}'`);
    this.name = 'UnpricedModelError';
  }
}

/** True iff `(provider, model)` has a price entry — the authority for platform-mode admission (REQ-6.1). */
export function isModelPriced(provider: ProviderId, model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RATE_TABLE[provider] ?? {}, model);
}

/**
 * Parse `PRICING_MARKUP` (a decimal string like '1.2' or '1') into an exact
 * integer fraction {num, den} so the markup applies with pure bigint math
 * (no float). '1.2' → {num: 12n, den: 10n}; '1' → {num: 1n, den: 1n}.
 * Computed once at module load.
 */
function parseMarkup(raw: string): { num: bigint; den: bigint } {
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid PRICING_MARKUP: '${raw}' (expected a non-negative decimal)`);
  }
  const [intPart, fracPart = ''] = raw.split('.');
  const num = BigInt(intPart + fracPart);
  const den = 10n ** BigInt(fracPart.length);
  return { num, den };
}

const MARKUP = parseMarkup(config.PRICING_MARKUP);

/** Ceil-divide two non-negative bigints (a / b rounded UP). */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export interface TurnUsageInput {
  provider: ProviderId;
  model: string;
  inputTokens: number | bigint;
  outputTokens: number | bigint;
}

/**
 * Both money figures for a priced platform turn (admin-platform REQ-4.2
 * option (i) / design Component 8).
 */
export interface TurnPriceParts {
  /**
   * Pre-markup rate-table cost in micro-USD: `inTok*inRate + outTok*outRate`.
   * Each per-token rate is itself ceil-rounded to whole micro-USD (a slight
   * over-statement for sub-micro-USD models, e.g. Haiku input). Persisted
   * as-charged at turn time — never re-derived from current config.
   */
  rawCost: bigint;
  /** The charged amount: `ceil(rawCost * markupNum / markupDen)`. */
  creditCost: bigint;
}

/**
 * Price a platform turn's metered usage, returning BOTH the pre-markup raw
 * cost and the marked-up credit cost (admin-platform REQ-4.2 option (i)).
 *
 * Identical validation and rate lookup as `priceTurnUsage` — which delegates
 * here, so every charged amount stays byte-identical. Pure integer/bigint
 * math throughout, ceil-rounded so Tradr never under-charges (REQ-5.1).
 * Throws `UnpricedModelError` for an unpriced model; callers gate via
 * `isModelPriced` first (REQ-5.6).
 */
export function priceTurnUsageParts(input: TurnUsageInput): TurnPriceParts {
  const { provider, model } = input;
  const rate = RATE_TABLE[provider]?.[model];
  if (!rate) {
    throw new UnpricedModelError(provider, model);
  }

  const inTok = BigInt(input.inputTokens);
  const outTok = BigInt(input.outputTokens);
  if (inTok < 0n || outTok < 0n) {
    throw new Error('token counts must be non-negative');
  }

  const rawCost = inTok * rate.inputMicroUsdPerToken + outTok * rate.outputMicroUsdPerToken;
  // Apply markup as an exact fraction, ceil-rounded.
  return { rawCost, creditCost: ceilDiv(rawCost * MARKUP.num, MARKUP.den) };
}

/**
 * Price a platform turn's metered usage in credits (micro-USD), as a bigint.
 *
 * cost = ceil((inTok*inRate + outTok*outRate) * markupNum / markupDen)
 *
 * Delegates to `priceTurnUsageParts` and returns its `creditCost` — the
 * contract and every charged amount are byte-identical to before the split.
 * Throws `UnpricedModelError` for an unpriced model; callers gate via
 * `isModelPriced` first (REQ-5.6 — metering never crashes on a missing price
 * under normal flow).
 */
export function priceTurnUsage(input: TurnUsageInput): bigint {
  return priceTurnUsageParts(input).creditCost;
}

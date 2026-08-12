// Market-data tools (design §Component 6, REQ-7).
//
// Three read-only tools backed by the Unusual Whales client on `ctx.uw`
// (REQ-1.4): `market_data_stock_quote`, `market_data_options_flow`, and
// `market_data_options_chain`. All `category:'market-data'`,
// `requires:'unusual-whales-key'`, and carry NO `maxEstTokens` — market data is
// not the egress concern (the trade-data cap governs that). Inputs are flat
// Zod objects validated by the dispatcher BEFORE any handler runs (REQ-7.3);
// handlers additionally re-parse defensively so they are safe in isolation.
//
// Each handler calls one UW method, forwarding `ctx.signal` so a per-tool
// timeout or client disconnect cancels the in-flight socket, then returns a
// COMPACT projection (REQ-7.4) — the UW envelopes are wide and the persisted
// `tool_result` must stay small. UW failures (`MarketDataError` /
// `PlatformRateLimitedError`) are caught and mapped to a `tool_result`-bucket
// error code (REQ-7.5) so the loop can continue and the model can adapt.
//
// The `market_data_options_chain` parsing is exported (`parseOptionChain`,
// `optionsChainInputSchema`) for reuse by the options-chain viewer endpoint
// (task 35, REQ-12.4) so the tool and the viewer share one parsing contract.

import { z } from 'zod';

import { parseOccSymbol } from '@tradr/shared';

import { MarketDataError, PlatformRateLimitedError } from '../lib/unusual-whales.client';

import { TOOL_RESULT_CODES } from './error-codes';
import type { ToolContext, ToolDefinition, ToolResult } from './types';

/** Ticker symbol: 1-6 uppercase letters/dots (REQ-7.3, design §Component 6). */
const symbolSchema = z
  .string()
  .regex(/^[A-Z.]{1,6}$/, 'symbol must be 1-6 uppercase letters or dots (e.g. AAPL, BRK.B)');

/** Options-flow result list bound (≤25, design §Component 6). */
const FLOW_LIMIT_MAX = 25;
const FLOW_LIMIT_DEFAULT = 10;

/** Compact projection caps so a persisted `tool_result` stays small (REQ-7.4). */
const CHAIN_MAX_CONTRACTS = 50;

// --- Input schemas (flat objects; optional fields OK in non-strict mode) -----

const stockQuoteInputSchema = z.object({ symbol: symbolSchema });

const optionsFlowInputSchema = z.object({
  symbol: symbolSchema,
  limit: z.number().int().min(1).max(FLOW_LIMIT_MAX).optional(),
});

/** Exported for the options-chain viewer (task 35, REQ-12.4). */
export const optionsChainInputSchema = z.object({
  symbol: symbolSchema,
  expiration: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expiration must be an ISO date (YYYY-MM-DD)')
    .optional(),
});

// --- Compact projections (REQ-7.4) ------------------------------------------
//
// The UW client returns the permissive `{ data }` envelope verbatim; these
// pickers keep only model-useful fields and never throw on a missing field.

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

/** Compact stock-quote projection from `{ data: {...} }`. */
function parseStockQuote(symbol: string, raw: unknown): Record<string, unknown> {
  const data = asRecord((raw as { data?: unknown }).data);
  return {
    symbol,
    ...pick(data, [
      'ticker',
      'price',
      'close',
      'open',
      'high',
      'low',
      'volume',
      'market_cap',
      'prev_close',
      'change',
      'change_percent',
    ]),
  };
}

/** Compact options-flow projection from `{ data: [...] }`, capped to `limit`. */
function parseOptionsFlow(symbol: string, raw: unknown, limit: number): Record<string, unknown> {
  const rows = asRows((raw as { data?: unknown }).data).slice(0, limit);
  const alerts = rows.map((row) =>
    pick(row, [
      'id',
      'ticker',
      'type',
      'option_chain',
      'strike',
      'expiry',
      'side',
      'price',
      'premium',
      'size',
      'volume',
      'open_interest',
      'executed_at',
    ]),
  );
  return { symbol, count: alerts.length, alerts };
}

/** Parse a UW numeric field, which arrives as a decimal STRING on most rows. */
function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The premium the calculator uses as the entry price.
 *
 * `last_price` is an actual fill and wins when present. Many contracts have
 * never traded, so the NBBO midpoint is the fallback — it is the neutral
 * fair-value convention, sitting between what you would pay and what you would
 * receive. Returns undefined when neither is available, which the calculator
 * hand-off already treats as "enter the premium manually".
 */
function premiumOf(lastPrice?: number, bid?: number, ask?: number): number | undefined {
  if (lastPrice !== undefined) return lastPrice;
  if (bid === undefined || ask === undefined) return undefined;
  return (bid + ask) / 2;
}

/**
 * Project one `option-contracts` row (design §Component 12, REQ-12.4).
 *
 * The endpoint sends `option_symbol` but NO strike / type / expiry fields, so
 * those are decoded from the OCC symbol. Prices arrive as decimal strings and
 * are normalised to numbers here so the viewer and the calculator do not each
 * re-parse them. An unparseable symbol keeps its priced fields rather than
 * being dropped.
 */
function projectContract(row: Record<string, unknown>): Record<string, unknown> {
  const optionSymbol = typeof row.option_symbol === 'string' ? row.option_symbol : '';

  const bid = asNumber(row.nbbo_bid);
  const ask = asNumber(row.nbbo_ask);
  const lastPrice = asNumber(row.last_price);
  const premium = premiumOf(lastPrice, bid, ask);

  const out: Record<string, unknown> = {
    option_symbol: optionSymbol,
    ...pick(row, ['volume', 'open_interest']),
  };

  const decoded = parseOccSymbol(optionSymbol);
  if (decoded.ok) {
    out.option_type = decoded.value.type;
    out.strike = Number(decoded.value.strike);
    out.expiry = decoded.value.expiration;
  }

  if (bid !== undefined) out.bid = bid;
  if (ask !== undefined) out.ask = ask;
  if (lastPrice !== undefined) out.last_price = lastPrice;
  if (premium !== undefined) out.premium = premium;

  for (const greek of ['implied_volatility', 'delta', 'gamma', 'theta', 'vega'] as const) {
    const n = asNumber(row[greek]);
    if (n !== undefined) out[greek] = n;
  }

  return out;
}

/**
 * The expiries a ticker has contracts for, soonest first, from
 * `expiry-breakdown`. Expiries already in the past are dropped — they cannot
 * be traded and would otherwise become the default "nearest".
 */
export function parseExpirations(raw: unknown, today: string): string[] {
  return asRows((raw as { data?: unknown }).data)
    .map((row) => (typeof row.expires === 'string' ? row.expires : undefined))
    .filter((e): e is string => e !== undefined && e >= today)
    .sort();
}

/**
 * Compact options-chain projection from `{ data: [...] }`, capped to `limit`.
 * Exported for the options-chain viewer (task 35, REQ-12.4) so the tool and the
 * viewer parse identically.
 *
 * Contracts are sorted by strike: the endpoint's own order is arbitrary, and a
 * cap applied to an arbitrary order yields an unusable scatter rather than a
 * chain. The cap is a parameter because its two consumers differ — the advisor
 * tool persists its result and must stay small, while the viewer renders one
 * expiry and wants the whole ladder.
 */
export function parseOptionChain(
  symbol: string,
  raw: unknown,
  expiration?: string,
  limit: number = CHAIN_MAX_CONTRACTS,
): Record<string, unknown> {
  const contracts = asRows((raw as { data?: unknown }).data)
    .map(projectContract)
    .sort((a, b) => ((a.strike as number) ?? 0) - ((b.strike as number) ?? 0))
    .slice(0, limit);

  return {
    symbol,
    ...(expiration ? { expiration } : {}),
    count: contracts.length,
    contracts,
  };
}

/** Today as an ISO date, for "is this expiry still tradeable". */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve which expiry to show, then fetch that expiry's contracts (REQ-12.4).
 * Shared by the advisor tool and the viewer endpoint so both scope the chain
 * identically.
 *
 * Two calls: the cheap expiry index, then one expiry's contracts. Both are
 * metered and cached like any other UW call. Fetching every expiry at once is
 * what the `option-chains` endpoint does, and it costs ~4.7 MB for a liquid
 * ticker to render a single ladder.
 *
 * A requested expiry the ticker does not have is reported as SYMBOL_NOT_FOUND
 * with an explicit message — the upstream would otherwise return an empty
 * envelope, which the client's empty-check reports as a bare "Symbol not
 * found." against a symbol that plainly exists.
 */
export async function fetchChainForExpiry(
  uw: NonNullable<ToolContext['uw']>,
  symbol: string,
  expiration?: string,
  signal?: AbortSignal,
): Promise<{ raw: unknown; expiration: string; expirations: string[] }> {
  const breakdown = await uw.getExpiryBreakdown(symbol, signal);
  const expirations = parseExpirations(breakdown, todayIso());

  if (expirations.length === 0) {
    throw new MarketDataError(
      TOOL_RESULT_CODES.SYMBOL_NOT_FOUND,
      'No tradeable option expirations for this symbol.',
    );
  }
  if (expiration !== undefined && !expirations.includes(expiration)) {
    throw new MarketDataError(
      TOOL_RESULT_CODES.SYMBOL_NOT_FOUND,
      'No contracts expire on that date for this symbol.',
    );
  }

  const chosen = expiration ?? expirations[0];
  const raw = await uw.getOptionContracts(symbol, chosen, signal);
  return { raw, expiration: chosen, expirations };
}

// --- Failure mapping (REQ-7.5) ----------------------------------------------

/**
 * Map a thrown UW failure to a `tool_result`-bucket error so the loop continues
 * (REQ-7.5). `MarketDataError` / `PlatformRateLimitedError` carry the mapped
 * code already; anything else is an unexpected throw → `MARKET_DATA_UNAVAILABLE`
 * (never surface raw provider/internal detail — REQ-6.8).
 */
function toErrorResult(error: unknown): ToolResult {
  if (error instanceof MarketDataError || error instanceof PlatformRateLimitedError) {
    return { status: 'error', code: error.code, message: error.message };
  }
  return {
    status: 'error',
    code: TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE,
    message: 'Unusual Whales is temporarily unavailable.',
  };
}

/** A market-data handler ran without a UW client — programming error (REQ-1.4). */
function requireUw(ctx: ToolContext): NonNullable<ToolContext['uw']> {
  if (!ctx.uw) {
    throw new MarketDataError(
      TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE,
      'Unusual Whales is temporarily unavailable.',
    );
  }
  return ctx.uw;
}

// --- Tool definitions --------------------------------------------------------

export const stockQuoteTool: ToolDefinition = {
  name: 'market_data_stock_quote',
  description:
    'Get a current stock quote (price, volume, day range) for a US ticker from Unusual Whales.',
  category: 'market-data',
  requires: 'unusual-whales-key',
  inputSchema: stockQuoteInputSchema,
  async handler(input, ctx) {
    const { symbol } = stockQuoteInputSchema.parse(input);
    try {
      const raw = await requireUw(ctx).getStockQuote(symbol, ctx.signal);
      return { status: 'ok', content: parseStockQuote(symbol, raw) };
    } catch (error) {
      return toErrorResult(error);
    }
  },
};

export const optionsFlowTool: ToolDefinition = {
  name: 'market_data_options_flow',
  description:
    'Get recent unusual options-flow alerts for a US ticker from Unusual Whales (limit 1-25, default 10).',
  category: 'market-data',
  requires: 'unusual-whales-key',
  inputSchema: optionsFlowInputSchema,
  async handler(input, ctx) {
    const { symbol, limit } = optionsFlowInputSchema.parse(input);
    const effectiveLimit = limit ?? FLOW_LIMIT_DEFAULT;
    try {
      const raw = await requireUw(ctx).getOptionsFlow(symbol, effectiveLimit, ctx.signal);
      return { status: 'ok', content: parseOptionsFlow(symbol, raw, effectiveLimit) };
    } catch (error) {
      return toErrorResult(error);
    }
  },
};

export const optionsChainTool: ToolDefinition = {
  name: 'market_data_options_chain',
  description:
    'Get the options chain (strikes, greeks, OI) for a US ticker from Unusual Whales, optionally for one expiration (YYYY-MM-DD).',
  category: 'market-data',
  requires: 'unusual-whales-key',
  inputSchema: optionsChainInputSchema,
  async handler(input, ctx) {
    const { symbol, expiration } = optionsChainInputSchema.parse(input);
    try {
      const resolved = await fetchChainForExpiry(requireUw(ctx), symbol, expiration, ctx.signal);
      return {
        status: 'ok',
        content: parseOptionChain(symbol, resolved.raw, resolved.expiration),
      };
    } catch (error) {
      return toErrorResult(error);
    }
  },
};

/** All three market-data tools, for registry wiring. */
export const marketDataTools: ToolDefinition[] = [
  stockQuoteTool,
  optionsFlowTool,
  optionsChainTool,
];

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

/**
 * Compact options-chain projection from `{ data: [...] }`, capped to
 * `CHAIN_MAX_CONTRACTS`. Exported for the options-chain viewer (task 35,
 * REQ-12.4) so the tool and the viewer parse identically.
 */
export function parseOptionChain(
  symbol: string,
  raw: unknown,
  expiration?: string,
): Record<string, unknown> {
  const rows = asRows((raw as { data?: unknown }).data).slice(0, CHAIN_MAX_CONTRACTS);
  const contracts = rows.map((row) =>
    pick(row, [
      'option_symbol',
      'option_type',
      'strike',
      'expiry',
      'last_price',
      'bid',
      'ask',
      'volume',
      'open_interest',
      'implied_volatility',
      'delta',
      'gamma',
      'theta',
      'vega',
    ]),
  );
  return {
    symbol,
    ...(expiration ? { expiration } : {}),
    count: contracts.length,
    contracts,
  };
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
      const raw = await requireUw(ctx).getOptionChain(symbol, expiration, ctx.signal);
      return { status: 'ok', content: parseOptionChain(symbol, raw, expiration) };
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

import { describe, expect, it, vi } from 'vitest';

import {
  MarketDataError,
  PlatformRateLimitedError,
  type UnusualWhalesClient,
} from '../lib/unusual-whales.client';

import { bucketOf, TOOL_RESULT_CODES } from './error-codes';
import {
  marketDataTools,
  optionsChainTool,
  optionsFlowTool,
  parseOptionChain,
  stockQuoteTool,
} from './market-data';
import { toolRegistry } from './registry';
import type { ToolContext } from './types';

// A UW client stub whose three methods are individually scriptable.
function stubUw(overrides: Partial<UnusualWhalesClient> = {}): UnusualWhalesClient {
  return {
    getStockQuote: vi.fn(async () => ({ data: {} })),
    getOptionsFlow: vi.fn(async () => ({ data: [] })),
    getOptionChain: vi.fn(async () => ({ data: [] })),
    ...overrides,
  };
}

function ctxWith(uw?: UnusualWhalesClient): ToolContext {
  return {
    userId: 'u1',
    conversationId: 'c1',
    signal: new AbortController().signal,
    ...(uw ? { uw } : {}),
  };
}

describe('market-data tool definitions', () => {
  it('declares all three with market-data category, UW requirement, no maxEstTokens', () => {
    for (const tool of marketDataTools) {
      expect(tool.category).toBe('market-data');
      expect(tool.requires).toBe('unusual-whales-key');
      expect(tool.maxEstTokens).toBeUndefined();
    }
    expect(marketDataTools.map((t) => t.name).sort()).toEqual([
      'market_data_options_chain',
      'market_data_options_flow',
      'market_data_stock_quote',
    ]);
  });

  it('registers all three tools in the registry', () => {
    expect(toolRegistry.market_data_stock_quote).toBe(stockQuoteTool);
    expect(toolRegistry.market_data_options_flow).toBe(optionsFlowTool);
    expect(toolRegistry.market_data_options_chain).toBe(optionsChainTool);
  });
});

describe('pre-call input validation (REQ-7.3)', () => {
  it('rejects a bad symbol BEFORE any outbound call', () => {
    const uw = stubUw();
    expect(stockQuoteTool.inputSchema.safeParse({ symbol: 'toolong' }).success).toBe(false);
    expect(stockQuoteTool.inputSchema.safeParse({ symbol: 'aapl' }).success).toBe(false);
    expect(stockQuoteTool.inputSchema.safeParse({ symbol: 'AAPL' }).success).toBe(true);
    expect(stockQuoteTool.inputSchema.safeParse({ symbol: 'BRK.B' }).success).toBe(true);
    expect(uw.getStockQuote).not.toHaveBeenCalled();
  });

  it('bounds the options-flow limit to 1-25 and allows it to be optional', () => {
    const s = optionsFlowTool.inputSchema;
    expect(s.safeParse({ symbol: 'AAPL' }).success).toBe(true);
    expect(s.safeParse({ symbol: 'AAPL', limit: 25 }).success).toBe(true);
    expect(s.safeParse({ symbol: 'AAPL', limit: 26 }).success).toBe(false);
    expect(s.safeParse({ symbol: 'AAPL', limit: 0 }).success).toBe(false);
  });

  it('validates the optional ISO expiration on the options chain', () => {
    const s = optionsChainTool.inputSchema;
    expect(s.safeParse({ symbol: 'AAPL' }).success).toBe(true);
    expect(s.safeParse({ symbol: 'AAPL', expiration: '2026-06-19' }).success).toBe(true);
    expect(s.safeParse({ symbol: 'AAPL', expiration: 'June' }).success).toBe(false);
  });
});

describe('stock-quote handler', () => {
  it('forwards ctx.signal and returns a compact projection (REQ-7.4)', async () => {
    const getStockQuote = vi.fn(async () => ({
      data: { ticker: 'AAPL', price: 200, volume: 1000, junk_field: 'x'.repeat(5000) },
    }));
    const ctx = ctxWith(stubUw({ getStockQuote }));
    const result = await stockQuoteTool.handler({ symbol: 'AAPL' }, ctx);

    expect(getStockQuote).toHaveBeenCalledWith('AAPL', ctx.signal);
    expect(result).toEqual({
      status: 'ok',
      content: { symbol: 'AAPL', ticker: 'AAPL', price: 200, volume: 1000 },
    });
    // Wide junk fields are dropped — the persisted result stays compact.
    expect(JSON.stringify(result)).not.toContain('junk_field');
  });

  it('maps a MarketDataError to its tool_result code + bucket (REQ-7.5)', async () => {
    const getStockQuote = vi.fn(async () => {
      throw new MarketDataError(TOOL_RESULT_CODES.SYMBOL_NOT_FOUND, 'Symbol not found.');
    });
    const result = await stockQuoteTool.handler(
      { symbol: 'ZZZZ' },
      ctxWith(stubUw({ getStockQuote })),
    );
    expect(result).toMatchObject({ status: 'error', code: 'SYMBOL_NOT_FOUND' });
    if (result.status === 'error') expect(bucketOf(result.code)).toBe('tool_result');
  });

  it('maps a PlatformRateLimitedError to PLATFORM_RATE_LIMITED', async () => {
    const getStockQuote = vi.fn(async () => {
      throw new PlatformRateLimitedError();
    });
    const result = await stockQuoteTool.handler(
      { symbol: 'AAPL' },
      ctxWith(stubUw({ getStockQuote })),
    );
    expect(result).toMatchObject({ status: 'error', code: 'PLATFORM_RATE_LIMITED' });
  });

  it('maps an unexpected throw to MARKET_DATA_UNAVAILABLE without leaking detail', async () => {
    const getStockQuote = vi.fn(async () => {
      throw new Error('socket reset at 10.0.0.1');
    });
    const result = await stockQuoteTool.handler(
      { symbol: 'AAPL' },
      ctxWith(stubUw({ getStockQuote })),
    );
    expect(result).toMatchObject({ status: 'error', code: 'MARKET_DATA_UNAVAILABLE' });
    if (result.status === 'error') expect(result.message).not.toContain('10.0.0.1');
  });
});

describe('options-flow handler', () => {
  it('forwards the limit, caps the alerts, and returns a compact projection', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      ticker: 'AAPL',
      strike: 100 + i,
      noise: 'x'.repeat(1000),
    }));
    const getOptionsFlow = vi.fn(async () => ({ data: rows }));
    const ctx = ctxWith(stubUw({ getOptionsFlow }));
    const result = await optionsFlowTool.handler({ symbol: 'AAPL', limit: 5 }, ctx);

    expect(getOptionsFlow).toHaveBeenCalledWith('AAPL', 5, ctx.signal);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const content = result.content as { count: number; alerts: unknown[] };
      expect(content.count).toBe(5);
      expect(content.alerts).toHaveLength(5);
    }
    expect(JSON.stringify(result)).not.toContain('noise');
  });

  it('uses the default limit when omitted', async () => {
    const getOptionsFlow = vi.fn(async () => ({ data: [] }));
    const ctx = ctxWith(stubUw({ getOptionsFlow }));
    await optionsFlowTool.handler({ symbol: 'AAPL' }, ctx);
    expect(getOptionsFlow).toHaveBeenCalledWith('AAPL', 10, ctx.signal);
  });
});

describe('options-chain handler + shared parsing (REQ-12.4)', () => {
  it('forwards the expiration and returns a compact projection', async () => {
    const getOptionChain = vi.fn(async () => ({
      data: [
        { option_symbol: 'AAPL260619C00200000', strike: 200, delta: 0.5, junk: 'y'.repeat(2000) },
      ],
    }));
    const ctx = ctxWith(stubUw({ getOptionChain }));
    const result = await optionsChainTool.handler(
      { symbol: 'AAPL', expiration: '2026-06-19' },
      ctx,
    );

    expect(getOptionChain).toHaveBeenCalledWith('AAPL', '2026-06-19', ctx.signal);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.content).toMatchObject({ symbol: 'AAPL', expiration: '2026-06-19', count: 1 });
    }
    expect(JSON.stringify(result)).not.toContain('junk');
  });

  it('exports parseOptionChain for the viewer (task 35) producing identical output', async () => {
    const raw = { data: [{ option_symbol: 'X', strike: 1, bid: 2, ask: 3, junk: 'z' }] };
    const getOptionChain = vi.fn(async () => raw);
    const handlerResult = await optionsChainTool.handler(
      { symbol: 'AAPL' },
      ctxWith(stubUw({ getOptionChain })),
    );
    const direct = parseOptionChain('AAPL', raw);
    if (handlerResult.status === 'ok') {
      expect(handlerResult.content).toEqual(direct);
    }
    expect(JSON.stringify(direct)).not.toContain('junk');
  });

  it('caps the chain to 50 contracts', () => {
    const data = Array.from({ length: 80 }, (_, i) => ({ strike: i }));
    const out = parseOptionChain('AAPL', { data }) as { count: number; contracts: unknown[] };
    expect(out.count).toBe(50);
    expect(out.contracts).toHaveLength(50);
  });

  // UW's enriched rows spell these three differently from the names the chain
  // viewer and calculator read; the projection normalises them.
  it('normalises UW expires/nbbo_bid/nbbo_ask onto expiry/bid/ask', () => {
    const out = parseOptionChain('AAPL', {
      data: [
        {
          option_symbol: 'AAPL260619C00190000',
          expires: '2026-06-19',
          nbbo_bid: 4.1,
          nbbo_ask: 4.25,
          strike: 190,
        },
      ],
    }) as { contracts: Record<string, unknown>[] };

    expect(out.contracts[0]).toMatchObject({ expiry: '2026-06-19', bid: 4.1, ask: 4.25 });
    expect(out.contracts[0].expires).toBeUndefined();
    expect(out.contracts[0].nbbo_bid).toBeUndefined();
  });

  it('prefers the plain spelling when UW sends both', () => {
    const out = parseOptionChain('AAPL', {
      data: [{ expiry: '2026-06-19', expires: '1999-01-01', bid: 1, nbbo_bid: 9 }],
    }) as { contracts: Record<string, unknown>[] };

    expect(out.contracts[0]).toMatchObject({ expiry: '2026-06-19', bid: 1 });
  });

  // The production 503: UW's default response is bare OCC symbol strings.
  it('decodes bare option-symbol strings into contracts', () => {
    const out = parseOptionChain('SPY', {
      data: ['SPY251219C00500000', 'SPY251219P00450000'],
    }) as { count: number; contracts: Record<string, unknown>[] };

    expect(out.count).toBe(2);
    expect(out.contracts[0]).toEqual({
      option_symbol: 'SPY251219C00500000',
      option_type: 'call',
      strike: 500,
      expiry: '2025-12-19',
    });
    expect(out.contracts[1]).toEqual({
      option_symbol: 'SPY251219P00450000',
      option_type: 'put',
      strike: 450,
      expiry: '2025-12-19',
    });
  });

  it('keeps an undecodable symbol as a bare row rather than dropping it', () => {
    const out = parseOptionChain('SPY', { data: ['NOT-AN-OCC-SYMBOL'] }) as {
      count: number;
      contracts: Record<string, unknown>[];
    };

    expect(out.count).toBe(1);
    expect(out.contracts[0]).toEqual({ option_symbol: 'NOT-AN-OCC-SYMBOL' });
  });
});

describe('missing UW client', () => {
  it('returns MARKET_DATA_UNAVAILABLE when ctx.uw is absent (REQ-1.4 guard)', async () => {
    const result = await stockQuoteTool.handler({ symbol: 'AAPL' }, ctxWith());
    expect(result).toMatchObject({ status: 'error', code: 'MARKET_DATA_UNAVAILABLE' });
  });
});

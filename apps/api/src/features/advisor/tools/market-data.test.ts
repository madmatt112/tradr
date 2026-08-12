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
  parseExpirations,
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
    getExpiryBreakdown: vi.fn(async () => ({ data: [{ expires: '2030-06-21' }] })),
    getOptionContracts: vi.fn(async () => ({ data: [] })),
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
    expect(s.safeParse({ symbol: 'AAPL', expiration: '2030-06-21' }).success).toBe(true);
    expect(s.safeParse({ symbol: 'AAPL', expiration: 'June' }).success).toBe(false);
  });
});

describe('stock-quote handler', () => {
  // A real `stock-state` row: decimal STRINGS, last trade in `close`, plus the
  // session/tape stamps. The previous fixture invented `{ticker, price,
  // volume}` — a shape the upstream never sent — so the projection agreed with
  // it while returning an empty object against the live API.
  it('forwards ctx.signal and returns a compact projection (REQ-7.4)', async () => {
    const getStockQuote = vi.fn(async () => ({
      data: {
        close: '772.5',
        open: '772.52',
        high: '773.32',
        low: '772.11',
        prev_close: '772.49',
        volume: 6675723,
        total_volume: 33075019,
        market_time: 'postmarket',
        tape_time: '2026-08-12T22:04:48Z',
        junk_field: 'x'.repeat(5000),
      },
    }));
    const ctx = ctxWith(stubUw({ getStockQuote }));
    const result = await stockQuoteTool.handler({ symbol: 'AAPL' }, ctx);

    expect(getStockQuote).toHaveBeenCalledWith('AAPL', ctx.signal);
    expect(result).toEqual({
      status: 'ok',
      content: {
        symbol: 'AAPL',
        price: 772.5,
        open: 772.52,
        high: 773.32,
        low: 772.11,
        prev_close: 772.49,
        volume: 6675723,
        total_volume: 33075019,
        market_time: 'postmarket',
        tape_time: '2026-08-12T22:04:48Z',
      },
    });
    // Wide junk fields are dropped — the persisted result stays compact.
    expect(JSON.stringify(result)).not.toContain('junk_field');
  });

  // The bug this guards: pointed at /info, every one of these fields was
  // absent, so the tool answered "here is your quote" with just the symbol.
  it('returns a price, not a bare symbol', async () => {
    const getStockQuote = vi.fn(async () => ({ data: { close: '772.5' } }));
    const result = await stockQuoteTool.handler(
      { symbol: 'AAPL' },
      ctxWith(stubUw({ getStockQuote })),
    );
    if (result.status === 'ok') {
      expect((result.content as { price?: number }).price).toBe(772.5);
    }
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
  it('scopes to the requested expiry and returns a compact projection', async () => {
    const getOptionContracts = vi.fn(async () => ({
      data: [{ option_symbol: 'AAPL300621C00200000', delta: '0.5', junk: 'y'.repeat(2000) }],
    }));
    const ctx = ctxWith(stubUw({ getOptionContracts }));
    const result = await optionsChainTool.handler(
      { symbol: 'AAPL', expiration: '2030-06-21' },
      ctx,
    );

    expect(getOptionContracts).toHaveBeenCalledWith('AAPL', '2030-06-21', ctx.signal);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.content).toMatchObject({ symbol: 'AAPL', expiration: '2030-06-21', count: 1 });
    }
    expect(JSON.stringify(result)).not.toContain('junk');
  });

  it('defaults to the nearest expiry when none is given', async () => {
    const getExpiryBreakdown = vi.fn(async () => ({
      // Deliberately unsorted, and carrying a past expiry that must be dropped.
      data: [{ expires: '2031-01-17' }, { expires: '2020-01-01' }, { expires: '2030-06-21' }],
    }));
    const getOptionContracts = vi.fn(async () => ({ data: [{ option_symbol: 'X' }] }));
    const ctx = ctxWith(stubUw({ getExpiryBreakdown, getOptionContracts }));

    await optionsChainTool.handler({ symbol: 'AAPL' }, ctx);

    expect(getOptionContracts).toHaveBeenCalledWith('AAPL', '2030-06-21', ctx.signal);
  });

  it('reports an expiry the ticker does not have, rather than "symbol not found"', async () => {
    const getExpiryBreakdown = vi.fn(async () => ({ data: [{ expires: '2030-06-21' }] }));
    const getOptionContracts = vi.fn(async () => ({ data: [] }));
    const result = await optionsChainTool.handler(
      { symbol: 'AAPL', expiration: '2030-06-22' },
      ctxWith(stubUw({ getExpiryBreakdown, getOptionContracts })),
    );

    expect(result).toMatchObject({ status: 'error', code: 'SYMBOL_NOT_FOUND' });
    if (result.status === 'error') expect(result.message).toContain('expire on that date');
    expect(getOptionContracts).not.toHaveBeenCalled();
  });

  it('exports parseOptionChain for the viewer (task 35) producing identical output', async () => {
    const raw = { data: [{ option_symbol: 'X', nbbo_bid: '2', nbbo_ask: '3', junk: 'z' }] };
    const getOptionContracts = vi.fn(async () => raw);
    const handlerResult = await optionsChainTool.handler(
      { symbol: 'AAPL' },
      ctxWith(stubUw({ getOptionContracts })),
    );
    const direct = parseOptionChain('AAPL', raw, '2030-06-21');
    if (handlerResult.status === 'ok') {
      expect(handlerResult.content).toEqual(direct);
    }
    expect(JSON.stringify(direct)).not.toContain('junk');
  });

  it('caps the chain to 50 contracts by default', () => {
    const data = Array.from({ length: 80 }, (_, i) => ({
      option_symbol: `AAPL300621C${String(i * 1000).padStart(8, '0')}`,
    }));
    const out = parseOptionChain('AAPL', { data }) as { count: number; contracts: unknown[] };
    expect(out.count).toBe(50);
    expect(out.contracts).toHaveLength(50);
  });

  // option-contracts rows carry NO strike/type/expiry fields — only the OCC
  // symbol — so the projection decodes them, and prices arrive as strings.
  it('decodes strike/type/expiry from the option symbol and numifies prices', () => {
    const out = parseOptionChain('SPY', {
      data: [
        {
          option_symbol: 'SPY260814C00780000',
          nbbo_bid: '0.38',
          nbbo_ask: '0.39',
          last_price: '0.39',
          implied_volatility: '0.1064785219753081',
          volume: 163686,
          open_interest: 154315,
        },
      ],
    }) as { contracts: Record<string, unknown>[] };

    expect(out.contracts[0]).toMatchObject({
      option_symbol: 'SPY260814C00780000',
      option_type: 'call',
      strike: 780,
      expiry: '2026-08-14',
      bid: 0.38,
      ask: 0.39,
      last_price: 0.39,
      volume: 163686,
      open_interest: 154315,
    });
    expect(out.contracts[0].implied_volatility).toBeCloseTo(0.10648, 5);
  });

  // The entry-price hand-off: a real fill wins, the NBBO mid stands in when a
  // contract has never traded.
  it('uses last_price as the premium when the contract has traded', () => {
    const out = parseOptionChain('SPY', {
      data: [
        { option_symbol: 'SPY260814C00780000', nbbo_bid: '1', nbbo_ask: '3', last_price: '2.5' },
      ],
    }) as { contracts: Record<string, unknown>[] };

    expect(out.contracts[0].premium).toBe(2.5);
  });

  it('falls back to the NBBO mid when there is no last trade', () => {
    const out = parseOptionChain('SPY', {
      data: [{ option_symbol: 'SPY260814C00780000', nbbo_bid: '25.19', nbbo_ask: '26.15' }],
    }) as { contracts: Record<string, unknown>[] };

    expect(out.contracts[0].premium).toBeCloseTo(25.67, 2);
    expect(out.contracts[0].last_price).toBeUndefined();
  });

  // The mid is rendered and written into the entry-price field, so it must not
  // carry binary-float noise: (4.10 + 4.30) / 2 is 4.199999999999999 raw.
  it('rounds the mid instead of emitting float noise', () => {
    const out = parseOptionChain('SPY', {
      data: [{ option_symbol: 'SPY260814C00780000', nbbo_bid: '4.10', nbbo_ask: '4.30' }],
    }) as { contracts: Record<string, unknown>[] };

    expect(out.contracts[0].premium).toBe(4.2);
    expect(String(out.contracts[0].premium)).toBe('4.2');
  });

  it('omits the premium when neither a trade nor a two-sided quote exists', () => {
    const out = parseOptionChain('SPY', {
      data: [{ option_symbol: 'SPY260814C00780000', nbbo_bid: '1' }],
    }) as { contracts: Record<string, unknown>[] };

    expect(out.contracts[0].premium).toBeUndefined();
  });

  // A cap over the endpoint's arbitrary order yields a scatter across strikes;
  // sorting first makes the kept slice an actual ladder.
  it('sorts by strike before capping', () => {
    const data = [
      { option_symbol: 'SPY260814C00780000' },
      { option_symbol: 'SPY260814C00100000' },
      { option_symbol: 'SPY260814C00500000' },
    ];
    const out = parseOptionChain('SPY', { data }, undefined, 2) as {
      contracts: Record<string, unknown>[];
    };

    expect(out.contracts.map((c) => c.strike)).toEqual([100, 500]);
  });

  it('keeps an undecodable symbol rather than dropping the row', () => {
    const out = parseOptionChain('SPY', {
      data: [{ option_symbol: 'NOT-AN-OCC-SYMBOL', nbbo_bid: '1', nbbo_ask: '2' }],
    }) as { count: number; contracts: Record<string, unknown>[] };

    expect(out.count).toBe(1);
    expect(out.contracts[0]).toMatchObject({ option_symbol: 'NOT-AN-OCC-SYMBOL', premium: 1.5 });
    expect(out.contracts[0].strike).toBeUndefined();
  });
});

describe('parseExpirations', () => {
  it('sorts soonest-first and drops expiries already past', () => {
    const raw = {
      data: [{ expires: '2027-01-15' }, { expires: '2020-01-01' }, { expires: '2030-06-21' }],
    };
    expect(parseExpirations(raw, '2026-01-01')).toEqual(['2027-01-15', '2030-06-21']);
  });

  it('keeps an expiry falling on today', () => {
    expect(parseExpirations({ data: [{ expires: '2026-08-12' }] }, '2026-08-12')).toEqual([
      '2026-08-12',
    ]);
  });

  it('tolerates a malformed payload', () => {
    expect(parseExpirations({ data: 'nope' }, '2026-01-01')).toEqual([]);
    expect(parseExpirations({}, '2026-01-01')).toEqual([]);
  });
});

describe('missing UW client', () => {
  it('returns MARKET_DATA_UNAVAILABLE when ctx.uw is absent (REQ-1.4 guard)', async () => {
    const result = await stockQuoteTool.handler({ symbol: 'AAPL' }, ctxWith());
    expect(result).toMatchObject({ status: 'error', code: 'MARKET_DATA_UNAVAILABLE' });
  });
});

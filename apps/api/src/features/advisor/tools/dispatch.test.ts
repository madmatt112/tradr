import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  buildToolContext,
  createTurnState,
  dispatchTool,
  PER_TOOL_FAILURE_LIMIT,
  TRADE_DATA_EGRESS_CAP,
  type DispatchDeps,
  type DispatchSnapshot,
  type ToolCall,
} from './dispatch';
import { bucketOf } from './error-codes';
import type { ToolContext, ToolDefinition, ToolResult } from './types';

// ---------------------------------------------------------------------------
// Scripted-tool-result fixture (design §Component 1 — for tasks 25/27 tests).
//
// `scriptedTool` builds a ToolDefinition whose handler returns a programmed
// ToolResult per call index, so the loop tests can construct degenerate/success
// sequences. The handler also records the ctx.signal it received so the
// per-tool-abort assertion can observe cancellation.
// ---------------------------------------------------------------------------

interface ScriptedToolOptions {
  results: ToolResult[];
  signals?: AbortSignal[];
}

function scriptedTool(
  overrides: Partial<ToolDefinition> & { script?: ScriptedToolOptions } = {},
): ToolDefinition {
  const { script, ...defOverrides } = overrides;
  let callIndex = 0;
  return {
    name: 'market_data_stock_quote',
    description: 'scripted',
    category: 'market-data',
    requires: 'unusual-whales-key',
    inputSchema: z.object({ symbol: z.string() }),
    handler: async (_input, ctx: ToolContext) => {
      script?.signals?.push(ctx.signal);
      const i = callIndex++;
      return script?.results[i] ?? { status: 'ok', content: null };
    },
    ...defOverrides,
  };
}

function makeRegistry(...defs: ToolDefinition[]): Record<string, ToolDefinition> {
  return Object.fromEntries(defs.map((d) => [d.name, d]));
}

const BASE = { userId: 'user-1', conversationId: 'conv-1' };

function snapshot(over: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
  return { toolUse: true, consent: true, hasUwKey: true, ...over };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    turnSignal: new AbortController().signal,
    perToolController: new AbortController(),
    ...over,
  };
}

function call(over: Partial<ToolCall> = {}): ToolCall {
  return { id: 'tc-1', name: 'market_data_stock_quote', arguments: { symbol: 'AAPL' }, ...over };
}

/** Assert an error result carries `code` AND that `code` lives in the expected bucket. */
function expectError(result: ToolResult, code: string, bucket = 'tool_result') {
  expect(result.status).toBe('error');
  if (result.status === 'error') {
    expect(result.code).toBe(code);
    expect(bucketOf(result.code)).toBe(bucket);
  }
}

describe('dispatchTool — step 1: registry lookup', () => {
  it('returns TOOL_NOT_PERMITTED for an unknown tool', async () => {
    const registry = makeRegistry(scriptedTool());
    const result = await dispatchTool(
      call({ name: 'does_not_exist' }),
      BASE,
      snapshot(),
      createTurnState(),
      deps({ registry }),
    );
    expectError(result, 'TOOL_NOT_PERMITTED');
  });
});

describe('dispatchTool — step 2: re-check requires', () => {
  it('TOOL_NOT_PERMITTED for trade-data tool when consent is off', async () => {
    const registry = makeRegistry(
      scriptedTool({ name: 't', category: 'trade-data', requires: 'trade-data-consent' }),
    );
    const result = await dispatchTool(
      call({ name: 't' }),
      BASE,
      snapshot({ consent: false }),
      createTurnState(),
      deps({ registry }),
    );
    expectError(result, 'TOOL_NOT_PERMITTED');
  });

  it('TOOL_NOT_PERMITTED for market-data tool when UW key absent', async () => {
    const registry = makeRegistry(scriptedTool());
    const result = await dispatchTool(
      call(),
      BASE,
      snapshot({ hasUwKey: false }),
      createTurnState(),
      deps({ registry }),
    );
    expectError(result, 'TOOL_NOT_PERMITTED');
  });

  it('TOOL_NOT_PERMITTED when model is conversation-only (toolUse false)', async () => {
    const registry = makeRegistry(scriptedTool());
    const result = await dispatchTool(
      call(),
      BASE,
      snapshot({ toolUse: false }),
      createTurnState(),
      deps({ registry }),
    );
    expectError(result, 'TOOL_NOT_PERMITTED');
  });

  it('does NOT execute the handler on a precondition failure', async () => {
    const handler = vi.fn(async () => ({ status: 'ok', content: 1 }) as ToolResult);
    const registry = makeRegistry(scriptedTool({ handler }));
    await dispatchTool(
      call(),
      BASE,
      snapshot({ hasUwKey: false }),
      createTurnState(),
      deps({ registry }),
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('dispatchTool — step 3: input validation', () => {
  it('returns (does not throw) TOOL_INPUT_INVALID on bad args', async () => {
    const registry = makeRegistry(scriptedTool());
    const result = await dispatchTool(
      call({ arguments: { symbol: 123 } }),
      BASE,
      snapshot(),
      createTurnState(),
      deps({ registry }),
    );
    expectError(result, 'TOOL_INPUT_INVALID');
  });

  it('does NOT execute the handler on invalid input', async () => {
    const handler = vi.fn(async () => ({ status: 'ok', content: 1 }) as ToolResult);
    const registry = makeRegistry(scriptedTool({ handler }));
    await dispatchTool(
      call({ arguments: {} }),
      BASE,
      snapshot(),
      createTurnState(),
      deps({ registry }),
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('dispatchTool — step 5: trade-data pre-call egress cap', () => {
  it('TRADE_DATA_BUDGET_EXCEEDED pre-call, no fetch, no persist accounting', async () => {
    const handler = vi.fn(async () => ({ status: 'ok', content: {} }) as ToolResult);
    const registry = makeRegistry(
      scriptedTool({
        name: 'trade_data_open_positions',
        category: 'trade-data',
        requires: 'trade-data-consent',
        maxEstTokens: 3000,
        inputSchema: z.object({}),
        handler,
      }),
    );
    const ts = createTurnState();
    ts.tradeDataTokens = TRADE_DATA_EGRESS_CAP - 1000; // remaining < 3000

    const result = await dispatchTool(
      call({ name: 'trade_data_open_positions', arguments: {} }),
      BASE,
      snapshot(),
      ts,
      deps({ registry }),
    );
    expectError(result, 'TRADE_DATA_BUDGET_EXCEEDED');
    expect(handler).not.toHaveBeenCalled();
    // No fetch → tradeDataTokens unchanged; not counted as a degenerate failure.
    expect(ts.tradeDataTokens).toBe(TRADE_DATA_EGRESS_CAP - 1000);
    expect(ts.totalDegenerateFailures).toBe(0);
  });

  it('charges maxEstTokens only on a successful trade-data call', async () => {
    const registry = makeRegistry(
      scriptedTool({
        name: 'trade_data_open_positions',
        category: 'trade-data',
        requires: 'trade-data-consent',
        maxEstTokens: 3000,
        inputSchema: z.object({}),
        handler: async () => ({ status: 'ok', content: {} }),
      }),
    );
    const ts = createTurnState();
    await dispatchTool(
      call({ name: 'trade_data_open_positions', arguments: {} }),
      BASE,
      snapshot(),
      ts,
      deps({ registry }),
    );
    expect(ts.tradeDataTokens).toBe(3000);
    expect(ts.successCount).toBe(1);
  });
});

describe('dispatchTool — step 4/7: degenerate guard', () => {
  it('counts degeneracy-class failures and withdraws the tool at K', async () => {
    const registry = makeRegistry(
      scriptedTool({
        script: {
          results: Array.from({ length: PER_TOOL_FAILURE_LIMIT }, () => ({
            status: 'error' as const,
            code: 'MARKET_DATA_UNAVAILABLE',
            message: 'down',
          })),
        },
      }),
    );
    const ts = createTurnState();
    for (let i = 0; i < PER_TOOL_FAILURE_LIMIT; i++) {
      const r = await dispatchTool(call(), BASE, snapshot(), ts, deps({ registry }));
      expectError(r, 'MARKET_DATA_UNAVAILABLE');
    }
    expect(ts.failByTool.market_data_stock_quote).toBe(PER_TOOL_FAILURE_LIMIT);
    expect(ts.totalDegenerateFailures).toBe(PER_TOOL_FAILURE_LIMIT);
    expect(ts.withdrawn.has('market_data_stock_quote')).toBe(true);
  });

  it('a withdrawn tool returns a standing TOOL_NOT_PERMITTED without executing', async () => {
    const handler = vi.fn(async () => ({ status: 'ok', content: 1 }) as ToolResult);
    const registry = makeRegistry(scriptedTool({ handler }));
    const ts = createTurnState();
    ts.withdrawn.add('market_data_stock_quote');
    const r = await dispatchTool(call(), BASE, snapshot(), ts, deps({ registry }));
    expectError(r, 'TOOL_NOT_PERMITTED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does NOT count SYMBOL_NOT_FOUND toward the degenerate budget', async () => {
    const registry = makeRegistry(
      scriptedTool({
        script: {
          results: [{ status: 'error', code: 'SYMBOL_NOT_FOUND', message: 'no such symbol' }],
        },
      }),
    );
    const ts = createTurnState();
    const r = await dispatchTool(call(), BASE, snapshot(), ts, deps({ registry }));
    expectError(r, 'SYMBOL_NOT_FOUND');
    expect(ts.totalDegenerateFailures).toBe(0);
    expect(ts.withdrawn.size).toBe(0);
  });

  it('does NOT count TRADE_DATA_BUDGET_EXCEEDED toward the degenerate budget', async () => {
    const registry = makeRegistry(
      scriptedTool({
        name: 'trade_data_open_positions',
        category: 'trade-data',
        requires: 'trade-data-consent',
        maxEstTokens: 20_000,
        inputSchema: z.object({}),
        handler: async () => ({ status: 'ok', content: {} }),
      }),
    );
    const ts = createTurnState();
    ts.tradeDataTokens = 5000; // 5000 + 20000 > cap
    const r = await dispatchTool(
      call({ name: 'trade_data_open_positions', arguments: {} }),
      BASE,
      snapshot(),
      ts,
      deps({ registry }),
    );
    expectError(r, 'TRADE_DATA_BUDGET_EXCEEDED');
    expect(ts.totalDegenerateFailures).toBe(0);
  });

  it('counts only REPEATED-identical TOOL_INPUT_INVALID, not the first', async () => {
    const registry = makeRegistry(scriptedTool());
    const ts = createTurnState();
    const bad = call({ arguments: { symbol: 123 } });

    const r1 = await dispatchTool(bad, BASE, snapshot(), ts, deps({ registry }));
    expectError(r1, 'TOOL_INPUT_INVALID');
    expect(ts.totalDegenerateFailures).toBe(0); // first occurrence not counted

    const r2 = await dispatchTool(bad, BASE, snapshot(), ts, deps({ registry }));
    expectError(r2, 'TOOL_INPUT_INVALID');
    expect(ts.totalDegenerateFailures).toBe(1); // repeated-identical is degenerate

    // A distinct invalid input is again a first occurrence → not counted.
    const r3 = await dispatchTool(
      call({ arguments: { symbol: 456 } }),
      BASE,
      snapshot(),
      ts,
      deps({ registry }),
    );
    expectError(r3, 'TOOL_INPUT_INVALID');
    expect(ts.totalDegenerateFailures).toBe(1);
  });

  it('records successCount on ok (productivity signal for the M gate)', async () => {
    const registry = makeRegistry(
      scriptedTool({ script: { results: [{ status: 'ok', content: {} }] } }),
    );
    const ts = createTurnState();
    const r = await dispatchTool(call(), BASE, snapshot(), ts, deps({ registry }));
    expect(r.status).toBe('ok');
    expect(ts.successCount).toBe(1);
    expect(ts.totalDegenerateFailures).toBe(0);
  });
});

describe('buildToolContext — per-tool abort controller seam', () => {
  it('aborting the per-tool controller cancels a handler reading ctx.signal', async () => {
    const perToolController = new AbortController();
    const turnSignal = new AbortController().signal;

    const registry = makeRegistry(
      scriptedTool({
        handler: (_input, ctx) =>
          new Promise<ToolResult>((resolve) => {
            ctx.signal.addEventListener('abort', () =>
              resolve({ status: 'error', code: 'TOOL_TIMEOUT', message: 'aborted' }),
            );
          }),
      }),
    );

    const promise = dispatchTool(
      call(),
      BASE,
      snapshot(),
      createTurnState(),
      deps({ turnSignal, perToolController, registry }),
    );
    // Simulate withToolTimeout (task 22) aborting the per-tool controller.
    perToolController.abort();
    const result = await promise;
    expectError(result, 'TOOL_TIMEOUT');
  });

  it('chains the turn signal: a turn abort propagates to ctx.signal', () => {
    const turnController = new AbortController();
    const perToolController = new AbortController();
    const ctx = buildToolContext(
      'market-data',
      BASE,
      turnController.signal,
      perToolController,
      () => ({
        getStockQuote: async () => null,
        getOptionsFlow: async () => null,
        getOptionChain: async () => null,
      }),
    );
    expect(ctx.signal.aborted).toBe(false);
    turnController.abort();
    expect(ctx.signal.aborted).toBe(true);
  });

  it('an already-aborted turn signal yields an aborted ctx.signal', () => {
    const turnController = new AbortController();
    turnController.abort();
    const ctx = buildToolContext('trade-data', BASE, turnController.signal, new AbortController());
    expect(ctx.signal.aborted).toBe(true);
  });

  it('UW client reaches market-data contexts only, never trade-data (REQ-1.4)', () => {
    const makeUw = () => ({
      getStockQuote: async () => null,
      getOptionsFlow: async () => null,
      getOptionChain: async () => null,
    });
    const md = buildToolContext(
      'market-data',
      BASE,
      new AbortController().signal,
      new AbortController(),
      makeUw,
    );
    const td = buildToolContext(
      'trade-data',
      BASE,
      new AbortController().signal,
      new AbortController(),
      makeUw,
    );
    expect(md.uw).toBeDefined();
    expect(td.uw).toBeUndefined();
  });
});

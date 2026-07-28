/**
 * Self-test for the loop test harness fixtures (Task 24).
 *
 * Proves:
 *   (a) the scriptable provider yields the scripted per-iteration event
 *       sequence (token / tool_call / usage), auto-appends `done`, records the
 *       per-call `tools` argument, and throws when over-called; and
 *   (b) the scriptable tool fixture yields the scripted per-(tool, callIndex)
 *       ToolResults when driven through the REAL `dispatchTool`.
 *
 * Tasks 25/27 consume these fixtures to drive the agentic loop.
 *
 * _Requirements: REQ-3.2, REQ-1.9 (testability enablement)_
 */
import { describe, expect, it } from 'vitest';

import type { ProviderStreamEvent } from '../providers/adapter';
import {
  createTurnState,
  dispatchTool,
  PER_TOOL_FAILURE_LIMIT,
  type DispatchDeps,
  type DispatchSnapshot,
  type ToolCall,
} from '../tools/dispatch';
import { bucketOf } from '../tools/error-codes';

import { makeScriptedProvider, toolCallEveryIteration } from './scriptable-provider';
import { errResult, makeScriptedRegistry, okResult } from './scriptable-tools';

async function drain(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const SIGNAL = new AbortController().signal;
const ARGS = { apiKey: 'k', modelId: 'm', messages: [], signal: SIGNAL };

// --- (a) scriptable provider -------------------------------------------------

describe('scriptable-provider', () => {
  it('yields each iteration script in order, auto-terminated by done', async () => {
    const provider = makeScriptedProvider({
      iterations: [
        [
          {
            type: 'tool_call',
            id: 'tc-0',
            name: 'market_data_stock_quote',
            arguments: { symbol: 'AAPL' },
          },
        ],
        [
          { type: 'token', delta: 'final ' },
          { type: 'token', delta: 'answer' },
        ],
      ],
    });

    const first = await drain(provider.streamChat(ARGS));
    expect(first).toEqual([
      {
        type: 'tool_call',
        id: 'tc-0',
        name: 'market_data_stock_quote',
        arguments: { symbol: 'AAPL' },
      },
      { type: 'done' },
    ]);

    const second = await drain(provider.streamChat(ARGS));
    expect(second).toEqual([
      { type: 'token', delta: 'final ' },
      { type: 'token', delta: 'answer' },
      { type: 'done' },
    ]);

    expect(provider.callCount).toBe(2);
  });

  it('records the tools argument passed on each call', async () => {
    const provider = makeScriptedProvider({ iterations: [[], []] });
    const tools = [{ name: 't', description: 'd', inputJsonSchema: {} }];

    await drain(provider.streamChat({ ...ARGS, tools }));
    await drain(provider.streamChat({ ...ARGS, tools: undefined }));

    expect(provider.toolsPerCall).toEqual([tools, undefined]);
  });

  it('toolCallEveryIteration forces a tool request on all N iterations', async () => {
    const provider = makeScriptedProvider({
      iterations: toolCallEveryIteration(6, 'market_data_stock_quote'),
    });
    for (let i = 0; i < 6; i++) {
      const events = await drain(provider.streamChat(ARGS));
      expect(events[0]).toMatchObject({ type: 'tool_call', name: 'market_data_stock_quote' });
      expect(events.at(-1)).toEqual({ type: 'done' });
    }
    expect(provider.callCount).toBe(6);
  });

  it('throws when over-called past the scripted iterations', () => {
    const provider = makeScriptedProvider({ iterations: [[]] });
    void drain(provider.streamChat(ARGS));
    expect(() => provider.streamChat(ARGS)).toThrow(/only 1 iteration/);
  });
});

// --- (b) scriptable tools (driven through real dispatchTool) -----------------

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
function call(name: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id: 'tc', name, arguments: { symbol: 'AAPL' }, ...over };
}

describe('scriptable-tools', () => {
  it('yields scripted per-(tool, callIndex) ToolResults via dispatchTool', async () => {
    const sr = makeScriptedRegistry({
      tool_a: {
        results: [
          errResult('MARKET_DATA_UNAVAILABLE'),
          errResult('MARKET_DATA_UNAVAILABLE'),
          errResult('MARKET_DATA_UNAVAILABLE'),
        ],
      },
      tool_b: { results: [okResult({ ok: true })] },
    });
    const ts = createTurnState();

    // tool_a: calls 1-3 → MARKET_DATA_UNAVAILABLE (a degeneracy-class code).
    for (let i = 0; i < 3; i++) {
      const r = await dispatchTool(
        call('tool_a'),
        { userId: 'u', conversationId: 'c' },
        snapshot(),
        ts,
        deps({ registry: sr.registry }),
      );
      expect(r.status).toBe('error');
      if (r.status === 'error') {
        expect(r.code).toBe('MARKET_DATA_UNAVAILABLE');
        expect(bucketOf(r.code)).toBe('tool_result');
      }
    }

    // tool_b: call 1 → ok.
    const rb = await dispatchTool(
      call('tool_b'),
      { userId: 'u', conversationId: 'c' },
      snapshot(),
      ts,
      deps({ registry: sr.registry }),
    );
    expect(rb.status).toBe('ok');

    expect(sr.callIndexOf('tool_a')).toBe(3);
    expect(sr.callIndexOf('tool_b')).toBe(1);
  });

  it('default ok past the end of a tool script', async () => {
    const sr = makeScriptedRegistry({ tool_a: { results: [] } });
    const ts = createTurnState();
    const r = await dispatchTool(
      call('tool_a'),
      { userId: 'u', conversationId: 'c' },
      snapshot(),
      ts,
      deps({ registry: sr.registry }),
    );
    expect(r.status).toBe('ok');
  });

  it('records the per-call ctx.signal the handler observed', async () => {
    const sr = makeScriptedRegistry({ tool_a: { results: [okResult()] } });
    const ts = createTurnState();
    await dispatchTool(
      call('tool_a'),
      { userId: 'u', conversationId: 'c' },
      snapshot(),
      ts,
      deps({ registry: sr.registry }),
    );
    expect(sr.signalsOf('tool_a')).toHaveLength(1);
    expect(sr.signalsOf('tool_a')[0]).toBeInstanceOf(AbortSignal);
  });

  it('PER_TOOL_FAILURE_LIMIT is importable for tasks 25/27 (smoke)', () => {
    expect(PER_TOOL_FAILURE_LIMIT).toBeGreaterThan(0);
  });
});

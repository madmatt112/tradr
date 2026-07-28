import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderAdapter } from './providers/adapter';
import {
  summarize,
  KEEP_VERBATIM_N,
  type SummarizableMessage,
  type SummarizeArgs,
  type PriorSummary,
} from './summarize';
import { bucketOf, NOTICE_CODES, EVENT_ERROR_CODES } from './tools/error-codes';

// --- cap-check mock ----------------------------------------------------------
// estimateTokens is the single estimator the service calls. We mock it to return
// a deterministic token count driven by the assembled list, so each test can pin
// exactly which slices fit under the 0.75 / 0.95 ratios.
// NOTE: vitest hoists vi.hoisted + vi.mock above all imports at transform time,
// so their placement below the import block here does not change execution order.

const { estimateTokensMock } = vi.hoisted(() => ({ estimateTokensMock: vi.fn() }));
vi.mock('./cap-check', () => ({ estimateTokens: estimateTokensMock }));

// A summarizable message whose token "weight" is encoded by its text length.
function msg(role: 'user' | 'assistant', text: string, atMs: number): SummarizableMessage {
  return { role, parts: [{ type: 'text', text }], createdAt: new Date(atMs) };
}

function fakeAdapter(): ProviderAdapter {
  return {
    id: 'claude',
    listModels: vi.fn(),
    translate: vi.fn(() => ({})),
    prepareForTokenCount: vi.fn(),
    streamChat: vi.fn(),
  };
}

const CONTEXT_WINDOW = 1000; // trigger 750, hard 950

function baseArgs(overrides: Partial<SummarizeArgs> = {}): SummarizeArgs {
  return {
    adapter: fakeAdapter(),
    apiKey: 'k',
    modelId: 'claude-test',
    contextWindow: CONTEXT_WINDOW,
    history: [],
    newMessage: [{ type: 'text', text: 'new' }],
    persona: null,
    imageCount: 0,
    priorSummary: null,
    runSummaryCall: vi.fn(async () => ({
      text: JSON.stringify({ prose: 'PROSE', tradeDataFigures: 'AAPL +$500' }),
    })),
    ...overrides,
  };
}

beforeEach(() => {
  estimateTokensMock.mockReset();
});

describe('summarize — trigger', () => {
  it('returns ok with no write when under the 0.75 trigger', async () => {
    estimateTokensMock.mockResolvedValue({ tokens: 100, source: 'fallback' });
    const history = [msg('user', 'hi', 1), msg('assistant', 'yo', 2)];
    const out = await summarize(baseArgs({ history }));
    expect(out).toEqual({
      kind: 'ok',
      summary: null,
      window: history,
      write: null,
      notice: null,
    });
  });
});

describe('summarize — {prose,tradeDataFigures} separation', () => {
  it('parses structured output into separate prose and figures', async () => {
    // 1st call (trigger): over 750. Slice-fit + re-estimate: under 950.
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' }) // trigger
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' }) // slice input cost
      .mockResolvedValueOnce({ tokens: 200, source: 'fallback' }); // re-estimate
    const history = [
      msg('user', 'old1', 1),
      msg('assistant', 'old2', 2),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    const out = await summarize(baseArgs({ history }));
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.summary).toEqual({ prose: 'PROSE', tradeDataFigures: 'AAPL +$500' });
    expect(out.write).not.toBeNull();
    expect(out.write?.prose).toBe('PROSE');
    expect(out.write?.tradeDataFigures).toBe('AAPL +$500');
    expect(out.notice).toBe(NOTICE_CODES.summarized);
    // summarized notice is in the notice bucket.
    expect(bucketOf(out.notice as string)).toBe('notice');
  });

  it('keeps the most-recent N messages verbatim and only summarizes older ones', async () => {
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' })
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' })
      .mockResolvedValueOnce({ tokens: 200, source: 'fallback' });
    const older = [msg('user', 'older', 1)];
    const window = Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i));
    const out = await summarize(baseArgs({ history: [...older, ...window] }));
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.window).toEqual(window);
    expect(out.write?.coveredThroughCreatedAt).toEqual(new Date(1));
  });
});

describe('summarize — extend-prior', () => {
  it('merges prior summary with the fresh one and excludes already-covered messages', async () => {
    const prior: PriorSummary = {
      prose: 'PRIOR',
      tradeDataFigures: 'TSLA -$100',
      coveredThroughCreatedAt: new Date(5),
    };
    const runSummaryCall = vi.fn<
      (
        input: import('./summarize').SummaryCallInput,
      ) => Promise<{ text: string; usage?: import('./summarize').SummaryUsage }>
    >(async () => ({
      text: JSON.stringify({ prose: 'FRESH', tradeDataFigures: 'AAPL +$500' }),
    }));
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' }) // trigger
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' }) // slice cost
      .mockResolvedValueOnce({ tokens: 200, source: 'fallback' }); // re-estimate
    // createdAt 3 is already covered by prior (<=5); 7 is new older; rest window.
    const history = [
      msg('user', 'covered', 3),
      msg('assistant', 'newolder', 7),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    const out = await summarize(baseArgs({ history, priorSummary: prior, runSummaryCall }));
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.summary?.prose).toBe('PRIOR\n\nFRESH');
    expect(out.summary?.tradeDataFigures).toBe('TSLA -$100\nAAPL +$500');
    // Only the new older message (id 7) was fed to the LLM, not the covered (3).
    const callArg = runSummaryCall.mock.calls[0][0];
    const fed = callArg.messages.map((m) => m.content).join(' ');
    expect(fed).toContain('newolder');
    expect(fed).not.toContain('covered');
    // boundary advances to the newest summarized message (id 7).
    expect(out.write?.coveredThroughCreatedAt).toEqual(new Date(7));
  });
});

describe('summarize — input-overflow chunking', () => {
  it('summarizes the oldest fit-able slice and leaves the rest in the window', async () => {
    const runSummaryCall = vi.fn(async () => ({
      text: JSON.stringify({ prose: 'CHUNK', tradeDataFigures: null }),
    }));
    // older = [o1@1, o2@2, o3@3]; full slice input too big, 2 too big, 1 fits.
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' }) // trigger
      .mockResolvedValueOnce({ tokens: 999, source: 'fallback' }) // slice count=3 too big
      .mockResolvedValueOnce({ tokens: 999, source: 'fallback' }) // slice count=2 too big
      .mockResolvedValueOnce({ tokens: 500, source: 'fallback' }) // slice count=1 fits
      .mockResolvedValueOnce({ tokens: 200, source: 'fallback' }); // re-estimate
    const history = [
      msg('user', 'o1', 1),
      msg('assistant', 'o2', 2),
      msg('user', 'o3', 3),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    const out = await summarize(baseArgs({ history, runSummaryCall }));
    if (out.kind !== 'ok') throw new Error('expected ok');
    // Only o1 summarized; o2, o3 left in front of the verbatim window.
    expect(out.write?.coveredThroughCreatedAt).toEqual(new Date(1));
    expect(out.window[0].parts[0]).toMatchObject({ text: 'o2' });
    expect(out.window[1].parts[0]).toMatchObject({ text: 'o3' });
    expect(out.window.length).toBe(2 + KEEP_VERBATIM_N);
  });

  it('signals CONVERSATION_TURN_TOO_LARGE when even a minimal slice cannot fit', async () => {
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' }) // trigger
      .mockResolvedValue({ tokens: 9999, source: 'fallback' }); // every slice too big
    const history = [
      msg('user', 'o1', 1),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    const out = await summarize(baseArgs({ history }));
    expect(out).toEqual({ kind: 'error', code: 'CONVERSATION_TURN_TOO_LARGE' });
    // event:error bucket.
    expect(bucketOf(EVENT_ERROR_CODES.CONVERSATION_TURN_TOO_LARGE)).toBe('event_error');
  });
});

describe('summarize — failure fallback', () => {
  it('L1: verbatim window + summary_failed notice when the LLM call throws and the window fits', async () => {
    const runSummaryCall = vi.fn(async () => {
      throw new Error('LLM down');
    });
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' }) // trigger
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' }) // slice input cost (then throws)
      .mockResolvedValueOnce({ tokens: 200, source: 'fallback' }); // L1 window fits
    const history = [
      msg('user', 'o1', 1),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    const out = await summarize(baseArgs({ history, runSummaryCall }));
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.write).toBeNull();
    expect(out.notice).toBe(NOTICE_CODES.summary_failed);
    expect(bucketOf(out.notice as string)).toBe('notice');
  });

  it('L2: shrinks the window oldest-first when L1 does not fit', async () => {
    const runSummaryCall = vi.fn(async () => {
      throw new Error('LLM down');
    });
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' }) // trigger
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' }) // slice input cost (then throws)
      .mockResolvedValueOnce({ tokens: 980, source: 'fallback' }) // L1 too big
      .mockResolvedValueOnce({ tokens: 900, source: 'fallback' }); // L2 shrunk fits
    const window = Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i));
    const history = [msg('user', 'o1', 1), ...window];
    const out = await summarize(baseArgs({ history, runSummaryCall }));
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.notice).toBe(NOTICE_CODES.summary_failed);
    // oldest window message dropped.
    expect(out.window.length).toBe(KEEP_VERBATIM_N - 1);
    expect(out.window[0]).toEqual(window[1]);
  });

  it('signals CONVERSATION_TURN_TOO_LARGE when even one message cannot fit after failure', async () => {
    const runSummaryCall = vi.fn(async () => {
      throw new Error('LLM down');
    });
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' }) // trigger
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' }) // slice input cost (then throws)
      .mockResolvedValue({ tokens: 9999, source: 'fallback' }); // every window size too big
    const history = [
      msg('user', 'o1', 1),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    const out = await summarize(baseArgs({ history, runSummaryCall }));
    expect(out).toEqual({ kind: 'error', code: 'CONVERSATION_TURN_TOO_LARGE' });
  });
});

describe('summarize — watchdog hooks', () => {
  it('clears the inactivity watchdog around the summary call and re-arms after', async () => {
    const onSummaryCallStart = vi.fn();
    const onSummaryCallEnd = vi.fn();
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' })
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' })
      .mockResolvedValueOnce({ tokens: 200, source: 'fallback' });
    const history = [
      msg('user', 'o1', 1),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    await summarize(baseArgs({ history, onSummaryCallStart, onSummaryCallEnd }));
    expect(onSummaryCallStart).toHaveBeenCalledTimes(1);
    expect(onSummaryCallEnd).toHaveBeenCalledTimes(1);
  });

  it('still re-arms the watchdog when the summary call throws', async () => {
    const onSummaryCallEnd = vi.fn();
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' })
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' })
      .mockResolvedValueOnce({ tokens: 200, source: 'fallback' });
    const history = [
      msg('user', 'o1', 1),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    await summarize(
      baseArgs({
        history,
        onSummaryCallEnd,
        runSummaryCall: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    );
    expect(onSummaryCallEnd).toHaveBeenCalledTimes(1);
  });
});

describe('summarize — originals never mutated', () => {
  it('does not mutate the input history array or its messages', async () => {
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800, source: 'fallback' })
      .mockResolvedValueOnce({ tokens: 100, source: 'fallback' })
      .mockResolvedValueOnce({ tokens: 200, source: 'fallback' });
    const history = [
      msg('user', 'o1', 1),
      ...Array.from({ length: KEEP_VERBATIM_N }, (_, i) => msg('user', `w${i}`, 100 + i)),
    ];
    const snapshot = JSON.stringify(history);
    await summarize(baseArgs({ history }));
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});

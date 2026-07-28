import { describe, expect, it } from 'vitest';

import {
  REVOKED_TOOL_RESULT_TEXT,
  flattenToolPartsForNonToolModel,
  redactRevokedToolResults,
  redactSummaryForProvider,
} from './replay-redaction';

type Msg = {
  role: 'user' | 'assistant';
  parts: { type: string; [k: string]: unknown }[];
};

function historyWithToolResult(): Msg[] {
  return [
    { role: 'user', parts: [{ type: 'text', text: 'show my P&L' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'You are up.' },
        { type: 'tool_call', id: 't1', name: 'trade_data_pnl_summary', arguments: {} },
        { type: 'tool_result', toolCallId: 't1', status: 'ok', content: { pnl: 4321 } },
      ],
    },
  ];
}

describe('redactRevokedToolResults', () => {
  it('with consent, returns the history unchanged by reference (identity)', () => {
    const history = historyWithToolResult();
    expect(redactRevokedToolResults(history, true)).toBe(history);
  });

  it('on revocation, replaces every tool_result part with the fixed marker', () => {
    const out = redactRevokedToolResults(historyWithToolResult(), false);

    const assistantParts = out[1]!.parts;
    expect(assistantParts.some((p) => p.type === 'tool_result')).toBe(false);
    expect(assistantParts).toContainEqual({ type: 'text', text: REVOKED_TOOL_RESULT_TEXT });
  });

  it('never feeds the raw revoked figure into the redacted output', () => {
    const out = redactRevokedToolResults(historyWithToolResult(), false);
    expect(JSON.stringify(out)).not.toContain('4321');
  });

  it('passes text / image / tool_call parts through unchanged on revocation', () => {
    const out = redactRevokedToolResults(historyWithToolResult(), false);
    const assistantParts = out[1]!.parts;
    expect(assistantParts).toContainEqual({ type: 'text', text: 'You are up.' });
    expect(assistantParts).toContainEqual({
      type: 'tool_call',
      id: 't1',
      name: 'trade_data_pnl_summary',
      arguments: {},
    });
  });

  it('does NOT mutate the input (render path / persisted snapshot untouched)', () => {
    const history = historyWithToolResult();
    const before = JSON.stringify(history);
    redactRevokedToolResults(history, false);
    // The source array — which the render path replays from — is unchanged.
    expect(JSON.stringify(history)).toBe(before);
    expect(history[1]!.parts.some((p) => p.type === 'tool_result')).toBe(true);
  });

  it('leaves messages without tool_result parts by reference (no needless copy)', () => {
    const history: Msg[] = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    const out = redactRevokedToolResults(history, false);
    expect(out[0]).toBe(history[0]);
  });
});

describe('flattenToolPartsForNonToolModel', () => {
  it('with toolUse, returns the history unchanged by reference (identity)', () => {
    const history = historyWithToolResult();
    expect(flattenToolPartsForNonToolModel(history, true)).toBe(history);
  });

  it('folds tool_call/tool_result into the assistant message text (no tool parts left)', () => {
    const out = flattenToolPartsForNonToolModel(historyWithToolResult(), false);
    const parts = out[1]!.parts;
    expect(parts.some((p) => p.type === 'tool_call' || p.type === 'tool_result')).toBe(false);
    // Original text part kept and ordered before the flattened marker.
    expect(parts[0]).toEqual({ type: 'text', text: 'You are up.' });
    const marker = parts.at(-1)!;
    expect(marker.type).toBe('text');
    expect(marker.text).toContain('[tool trade_data_pnl_summary →');
    expect(marker.text).toContain('4321');
  });

  it('adds NO messages and preserves role order (cannot break alternation)', () => {
    const before = historyWithToolResult();
    const out = flattenToolPartsForNonToolModel(before, false);
    expect(out).toHaveLength(before.length);
    expect(out.map((m) => m.role)).toEqual(before.map((m) => m.role));
  });

  it('runs after redaction: a revoked tool_result flattens to the marker, no figure leaks', () => {
    const redacted = redactRevokedToolResults(historyWithToolResult(), false);
    const out = flattenToolPartsForNonToolModel(redacted, false);
    expect(JSON.stringify(out)).not.toContain('4321');
    // The revoked marker text survives as plain assistant text.
    expect(JSON.stringify(out)).toContain(REVOKED_TOOL_RESULT_TEXT);
  });

  it('leaves messages without tool parts by reference (no needless copy)', () => {
    const history: Msg[] = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    const out = flattenToolPartsForNonToolModel(history, false);
    expect(out[0]).toBe(history[0]);
  });

  it('does NOT mutate the input (render path / persisted snapshot untouched)', () => {
    const history = historyWithToolResult();
    const before = JSON.stringify(history);
    flattenToolPartsForNonToolModel(history, false);
    expect(JSON.stringify(history)).toBe(before);
  });

  it('handles a tool_call with no paired tool_result', () => {
    const history: Msg[] = [
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 't9', name: 'market_data_stock_quote', arguments: {} }],
      },
    ];
    const out = flattenToolPartsForNonToolModel(history, false);
    const marker = out[0]!.parts.at(-1)!;
    expect(marker.text).toBe('[tool market_data_stock_quote → (no result)]');
  });
});

describe('redactSummaryForProvider', () => {
  const summary = () => ({ prose: 'You traded AAPL.', tradeDataFigures: 'P&L: +$4321' });

  it('with consent, returns the summary unchanged by reference (figures kept)', () => {
    const s = summary();
    expect(redactSummaryForProvider(s, true)).toBe(s);
  });

  it('on revocation, omits tradeDataFigures but preserves the prose', () => {
    const out = redactSummaryForProvider(summary(), false);
    expect(out).toEqual({ prose: 'You traded AAPL.', tradeDataFigures: undefined });
    expect(JSON.stringify(out)).not.toContain('4321');
  });

  it('does NOT mutate the input on revocation', () => {
    const s = summary();
    const before = JSON.stringify(s);
    redactSummaryForProvider(s, false);
    expect(JSON.stringify(s)).toBe(before);
    expect(s.tradeDataFigures).toBe('P&L: +$4321');
  });

  it('handles a null summary safely', () => {
    expect(redactSummaryForProvider(null, false)).toBe(null);
    expect(redactSummaryForProvider(null, true)).toBe(null);
  });

  it('handles an undefined summary safely', () => {
    expect(redactSummaryForProvider(undefined, false)).toBe(undefined);
  });
});

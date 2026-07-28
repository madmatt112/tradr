import { describe, expect, it } from 'vitest';

import type { CanonicalPart } from '@tradr/shared';

import { assembleCanonicalMessages } from './assemble';

const userText = (text: string): CanonicalPart[] => [{ type: 'text', text }];

describe('assembleCanonicalMessages', () => {
  it('emits a leading system message from the persona, then history, then the new user message', () => {
    const result = assembleCanonicalMessages({
      history: [
        { role: 'user', parts: userText('hello') },
        { role: 'assistant', parts: userText('hi there') },
      ],
      persona: { systemPrompt: 'You are a trading advisor.' },
      newMessage: userText('what about NVDA?'),
    });

    expect(result).toEqual([
      { role: 'system', content: 'You are a trading advisor.' },
      { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'hi there' }] },
      { role: 'user', parts: [{ type: 'text', text: 'what about NVDA?' }] },
    ]);
  });

  it('does NOT emit a system message when persona is null', () => {
    const result = assembleCanonicalMessages({
      history: [{ role: 'user', parts: userText('hello') }],
      persona: null,
      newMessage: userText('follow up'),
    });

    expect(result.some((m) => m.role === 'system')).toBe(false);
    expect(result).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { role: 'user', parts: [{ type: 'text', text: 'follow up' }] },
    ]);
  });

  it('produces just [system, newUser] when history is empty', () => {
    const result = assembleCanonicalMessages({
      history: [],
      persona: { systemPrompt: 'sys' },
      newMessage: userText('first message'),
    });

    expect(result).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', parts: [{ type: 'text', text: 'first message' }] },
    ]);
  });

  it('preserves image parts in the new user message', () => {
    const parts: CanonicalPart[] = [
      { type: 'text', text: 'review this chart' },
      { type: 'image', format: 'png', dataBase64: 'AAAA' },
    ];

    const result = assembleCanonicalMessages({
      history: [],
      persona: null,
      newMessage: parts,
    });

    expect(result).toEqual([{ role: 'user', parts }]);
  });

  it('prepends the summary as a system message ahead of the verbatim window', () => {
    const result = assembleCanonicalMessages({
      history: [{ role: 'user', parts: userText('older message') }],
      persona: { systemPrompt: 'You are a trading advisor.' },
      summary: { prose: 'Earlier the user discussed NVDA.' },
      newMessage: userText('continue'),
    });

    expect(result).toEqual([
      { role: 'system', content: 'You are a trading advisor.' },
      { role: 'system', content: 'Earlier the user discussed NVDA.' },
      { role: 'user', parts: [{ type: 'text', text: 'older message' }] },
      { role: 'user', parts: [{ type: 'text', text: 'continue' }] },
    ]);
  });

  it('appends tradeDataFigures to the summary system message when present', () => {
    const result = assembleCanonicalMessages({
      history: [],
      persona: null,
      summary: { prose: 'Discussed positions.', tradeDataFigures: 'NVDA: +12%' },
      newMessage: userText('next'),
    });

    expect(result).toEqual([
      { role: 'system', content: 'Discussed positions.\n\nNVDA: +12%' },
      { role: 'user', parts: [{ type: 'text', text: 'next' }] },
    ]);
  });

  it('emits no summary system message when summary is null or absent', () => {
    const withNull = assembleCanonicalMessages({
      history: [],
      persona: null,
      summary: null,
      newMessage: userText('a'),
    });
    const withAbsent = assembleCanonicalMessages({
      history: [],
      persona: null,
      newMessage: userText('a'),
    });

    expect(withNull.filter((m) => m.role === 'system')).toHaveLength(0);
    expect(withAbsent.filter((m) => m.role === 'system')).toHaveLength(0);
  });

  it('passes through tool_call and tool_result parts in history unchanged', () => {
    const assistantParts: CanonicalPart[] = [
      { type: 'text', text: 'Let me check that.' },
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'market_data_stock_quote',
        arguments: { symbol: 'NVDA' },
      },
      { type: 'tool_result', toolCallId: 'call_1', status: 'ok', content: { price: 123 } },
    ];

    const result = assembleCanonicalMessages({
      history: [
        { role: 'user', parts: userText('quote NVDA') },
        { role: 'assistant', parts: assistantParts },
      ],
      persona: null,
      newMessage: userText('thanks'),
    });

    expect(result).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'quote NVDA' }] },
      { role: 'assistant', parts: assistantParts },
      { role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
    ]);
  });

  it('does not mutate its inputs', () => {
    const history = [{ role: 'user' as const, parts: userText('hello') }];
    const newMessage = userText('new');
    const historyParts = history[0].parts;

    assembleCanonicalMessages({ history, persona: { systemPrompt: 'sys' }, newMessage });

    expect(history).toHaveLength(1);
    expect(history[0].parts).toBe(historyParts);
    expect(history[0].parts).toEqual([{ type: 'text', text: 'hello' }]);
    expect(newMessage).toEqual([{ type: 'text', text: 'new' }]);
  });
});

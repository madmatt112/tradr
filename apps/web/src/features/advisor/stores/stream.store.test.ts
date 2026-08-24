// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { useStreamStore } from './stream.store';

describe('stream.store', () => {
  afterEach(() => {
    useStreamStore.setState({
      byConversation: {},
      toolsByConversation: {},
      billingModeByConversation: {},
      userMessageByConversation: {},
    });
  });

  it('appendToken starts a streaming entry and accumulates deltas', () => {
    const { appendToken } = useStreamStore.getState();
    appendToken('c1', 'Hel');
    appendToken('c1', 'lo');
    expect(useStreamStore.getState().byConversation.c1).toEqual({
      kind: 'streaming',
      text: 'Hello',
    });
  });

  it('appendToken updates only the targeted conversation key', () => {
    const { appendToken } = useStreamStore.getState();
    appendToken('c1', 'a');
    appendToken('c2', 'b');
    const { byConversation } = useStreamStore.getState();
    expect(byConversation.c1).toEqual({ kind: 'streaming', text: 'a' });
    expect(byConversation.c2).toEqual({ kind: 'streaming', text: 'b' });
  });

  it('setError keeps the partial streamed text and records the error code', () => {
    const { appendToken, setError } = useStreamStore.getState();
    appendToken('c1', 'partial');
    setError('c1', 'PROVIDER_ERROR');
    expect(useStreamStore.getState().byConversation.c1).toEqual({
      kind: 'error',
      text: 'partial',
      errorCode: 'PROVIDER_ERROR',
    });
  });

  it('setDone retains the streamed text and records the messageId', () => {
    const { appendToken, setDone } = useStreamStore.getState();
    appendToken('c1', 'answer');
    setDone('c1', 'msg-123');
    expect(useStreamStore.getState().byConversation.c1).toEqual({
      kind: 'done',
      text: 'answer',
      messageId: 'msg-123',
    });
  });

  it('reset removes only the targeted conversation entry', () => {
    const { appendToken, reset } = useStreamStore.getState();
    appendToken('c1', 'x');
    appendToken('c2', 'y');
    reset('c1');
    const { byConversation } = useStreamStore.getState();
    expect(byConversation.c1).toBeUndefined();
    expect(byConversation.c2).toEqual({ kind: 'streaming', text: 'y' });
  });

  it('appendToken after a non-streaming state restarts text from empty', () => {
    const { appendToken, setDone } = useStreamStore.getState();
    appendToken('c1', 'old');
    setDone('c1', 'msg-1');
    appendToken('c1', 'new');
    expect(useStreamStore.getState().byConversation.c1).toEqual({ kind: 'streaming', text: 'new' });
  });

  it('addToolCall appends a pending tool entry, addToolResult resolves it by id', () => {
    const { addToolCall, addToolResult } = useStreamStore.getState();
    addToolCall('c1', {
      id: 'tc-1',
      name: 'market_data_quote',
      argumentsPreview: '{"symbol":"AAPL"}',
    });
    expect(useStreamStore.getState().toolsByConversation.c1).toEqual([
      {
        id: 'tc-1',
        name: 'market_data_quote',
        argumentsPreview: '{"symbol":"AAPL"}',
        status: 'pending',
      },
    ]);

    addToolResult('c1', { toolCallId: 'tc-1', status: 'ok', summary: 'AAPL 190.12' });
    expect(useStreamStore.getState().toolsByConversation.c1).toEqual([
      {
        id: 'tc-1',
        name: 'market_data_quote',
        argumentsPreview: '{"symbol":"AAPL"}',
        status: 'ok',
        summary: 'AAPL 190.12',
      },
    ]);
  });

  it('addToolResult with no matching pending call leaves activity unchanged', () => {
    const { addToolCall, addToolResult } = useStreamStore.getState();
    addToolCall('c1', { id: 'tc-1', name: 'x', argumentsPreview: '' });
    addToolResult('c1', { toolCallId: 'other', status: 'error', summary: 'nope' });
    const tools = useStreamStore.getState().toolsByConversation.c1;
    expect(tools).toEqual([{ id: 'tc-1', name: 'x', argumentsPreview: '', status: 'pending' }]);
  });

  it('reset clears tool activity for the targeted conversation only', () => {
    const { addToolCall, reset } = useStreamStore.getState();
    addToolCall('c1', { id: 'tc-1', name: 'x', argumentsPreview: '' });
    addToolCall('c2', { id: 'tc-2', name: 'y', argumentsPreview: '' });
    reset('c1');
    const { toolsByConversation } = useStreamStore.getState();
    expect(toolsByConversation.c1).toBeUndefined();
    expect(toolsByConversation.c2).toEqual([
      { id: 'tc-2', name: 'y', argumentsPreview: '', status: 'pending' },
    ]);
  });

  it('start clears the previous turn, records the user message, and marks the turn pending', () => {
    const { appendToken, addToolCall, setDone, start } = useStreamStore.getState();
    appendToken('c1', 'old answer');
    setDone('c1', 'msg-old');
    addToolCall('c1', { id: 'tc-old', name: 'x', argumentsPreview: '' });

    const userMessage = { clientMessageId: 'cm-1', text: 'next question', attachments: [] };
    start('c1', userMessage);

    const state = useStreamStore.getState();
    expect(state.byConversation.c1).toEqual({ kind: 'pending' });
    expect(state.toolsByConversation.c1).toBeUndefined();
    expect(state.userMessageByConversation.c1).toEqual(userMessage);
  });

  it('adopt copies every slice under the new id and leaves the source in place', () => {
    const { start, appendToken, addToolCall, setBillingMode, setDone, adopt } =
      useStreamStore.getState();
    start('new', { clientMessageId: 'cm-1', text: 'hi', attachments: [] });
    addToolCall('new', { id: 'tc-1', name: 'x', argumentsPreview: '' });
    setBillingMode('new', { mode: 'byok' });
    appendToken('new', 'answer');
    setDone('new', 'msg-1');

    adopt('new', 'c9');

    const state = useStreamStore.getState();
    for (const id of ['new', 'c9']) {
      expect(state.byConversation[id]).toEqual({
        kind: 'done',
        text: 'answer',
        messageId: 'msg-1',
      });
      expect(state.toolsByConversation[id]).toHaveLength(1);
      expect(state.billingModeByConversation[id]).toEqual({ mode: 'byok' });
      expect(state.userMessageByConversation[id]?.text).toBe('hi');
    }
  });

  it('adopt is a no-op when the source has no entry', () => {
    useStreamStore.getState().adopt('missing', 'c9');
    expect(useStreamStore.getState().byConversation.c9).toBeUndefined();
  });

  it('reset also drops the recorded user message', () => {
    const { start, reset } = useStreamStore.getState();
    start('c1', { clientMessageId: 'cm-1', text: 'hi', attachments: [] });
    reset('c1');
    expect(useStreamStore.getState().userMessageByConversation.c1).toBeUndefined();
  });
});

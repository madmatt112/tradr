// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSseStream, SsePreStreamError } from '../lib/sse';
import { useStreamStore } from '../stores/stream.store';

import { useAdvisorStream, type StreamSubmitInput } from './useAdvisorStream';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/sse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sse')>()),
  readSseStream: vi.fn(),
}));

const CONV_ID = '11111111-1111-1111-1111-111111111111';

function makeInput(): StreamSubmitInput {
  return {
    conversationId: CONV_ID,
    clientMessageId: '22222222-2222-2222-2222-222222222222',
    text: 'hello',
  };
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  useStreamStore.setState({
    byConversation: {},
    toolsByConversation: {},
    billingModeByConversation: {},
    userMessageByConversation: {},
  });
  vi.restoreAllMocks();
  vi.mocked(readSseStream).mockReset();
});

describe('useAdvisorStream', () => {
  it('resets then drives store to done state via SSE callbacks (deltas bypass query cache)', async () => {
    vi.mocked(readSseStream).mockImplementation(async (_url, opts) => {
      opts.onToken('Hel');
      opts.onToken('lo');
      opts.onDone('msg-1');
      return { messageId: 'msg-1', deduped: false };
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

    const { result } = renderHook(() => useAdvisorStream(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync(makeInput());

    expect(useStreamStore.getState().byConversation[CONV_ID]).toEqual({
      kind: 'done',
      text: 'Hello',
      messageId: 'msg-1',
    });
  });

  it('wires onToolCall/onToolResult into the store tool activity', async () => {
    vi.mocked(readSseStream).mockImplementation(async (_url, opts) => {
      opts.onToolCall?.({ id: 'tc-1', name: 'market_data_quote', argumentsPreview: '{}' });
      opts.onToolResult?.({ toolCallId: 'tc-1', status: 'ok', summary: 'AAPL 190.12' });
      opts.onDone('msg-1');
      return { messageId: 'msg-1', deduped: false };
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

    const { result } = renderHook(() => useAdvisorStream(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync(makeInput());

    expect(useStreamStore.getState().toolsByConversation[CONV_ID]).toEqual([
      {
        id: 'tc-1',
        name: 'market_data_quote',
        argumentsPreview: '{}',
        status: 'ok',
        summary: 'AAPL 190.12',
      },
    ]);
  });

  it('onSuccess invalidates ONLY the conversation query (not persona/key queries)', async () => {
    vi.mocked(readSseStream).mockImplementation(async (_url, opts) => {
      opts.onDone('msg-1');
      return { messageId: 'msg-1', deduped: false };
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useAdvisorStream(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync(makeInput());

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['advisor', 'conversation', CONV_ID],
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['advisor', 'personas'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['advisor', 'keys'] });
  });

  it('records error code in the store when the SSE stream errors', async () => {
    vi.mocked(readSseStream).mockImplementation(async (_url, opts) => {
      opts.onToken('partial');
      opts.onError('STREAM_DISCONNECTED');
      throw new Error('stream dropped');
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

    const { result } = renderHook(() => useAdvisorStream(), { wrapper: makeWrapper(qc) });
    await expect(result.current.mutateAsync(makeInput())).rejects.toThrow('stream dropped');

    expect(useStreamStore.getState().byConversation[CONV_ID]).toEqual({
      kind: 'error',
      text: 'partial',
      errorCode: 'STREAM_DISCONNECTED',
    });
  });

  it('does NOT auto-retry on failure (retry: 0) — mutationFn runs exactly once', async () => {
    vi.mocked(readSseStream).mockRejectedValue(new Error('boom'));
    // No mutation retry default set: the hook's own retry: 0 must be authoritative.
    const qc = new QueryClient();

    const { result } = renderHook(() => useAdvisorStream(), { wrapper: makeWrapper(qc) });
    result.current.mutate(makeInput());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readSseStream).toHaveBeenCalledTimes(1);
  });

  it('marks the turn pending and records the user message before the first frame', async () => {
    let seenMidStream: unknown;
    vi.mocked(readSseStream).mockImplementation(async (_url, opts) => {
      seenMidStream = useStreamStore.getState().byConversation[CONV_ID];
      opts.onDone('msg-1');
      return { messageId: 'msg-1', deduped: false };
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

    const { result } = renderHook(() => useAdvisorStream(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync(makeInput());

    expect(seenMidStream).toEqual({ kind: 'pending' });
    expect(useStreamStore.getState().userMessageByConversation[CONV_ID]).toEqual({
      clientMessageId: '22222222-2222-2222-2222-222222222222',
      text: 'hello',
      attachments: [],
    });
  });

  it('moves a pre-stream refusal into the error state (no indicator left running)', async () => {
    vi.mocked(readSseStream).mockRejectedValue(
      new SsePreStreamError(402, 'INSUFFICIENT_CREDITS', 'out of credits'),
    );
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

    const { result } = renderHook(() => useAdvisorStream(), { wrapper: makeWrapper(qc) });
    await expect(result.current.mutateAsync(makeInput())).rejects.toThrow('out of credits');

    expect(useStreamStore.getState().byConversation[CONV_ID]).toEqual({
      kind: 'error',
      text: '',
      errorCode: 'INSUFFICIENT_CREDITS',
    });
    // The sent message stays on screen next to the retry control.
    expect(useStreamStore.getState().userMessageByConversation[CONV_ID]?.text).toBe('hello');
  });

  it('a failure with no error frame and no code lands as STREAM_DISCONNECTED', async () => {
    vi.mocked(readSseStream).mockRejectedValue(new Error('boom'));
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

    const { result } = renderHook(() => useAdvisorStream(), { wrapper: makeWrapper(qc) });
    await expect(result.current.mutateAsync(makeInput())).rejects.toThrow('boom');

    expect(useStreamStore.getState().byConversation[CONV_ID]).toEqual({
      kind: 'error',
      text: '',
      errorCode: 'STREAM_DISCONNECTED',
    });
  });
});

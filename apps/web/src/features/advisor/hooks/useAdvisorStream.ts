// useAdvisorStream — TanStack Query mutation wrapper around the SSE streaming
// endpoint (design §Component 9).
//
// Token deltas DO NOT travel through TanStack Query's cache — they travel through
// the Zustand stream store. The mutation exists for lifecycle management only
// (loading state for the submit button, retry control).
//
// REQ-1.16 / REQ-1.7 / REQ-3.13: this is a useMutation, NOT a useQuery. It uses
// retry: 0 and networkMode: 'always' so the client never auto-reconnects on a
// transport-level drop — the user must click the retry button.

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { StreamRequestInput } from '@tradr/shared/schemas/advisor';

import { resolveApiUrl } from '../../../lib/api';
import { readSseStream } from '../lib/sse';
import { useStreamStore } from '../stores/stream.store';

export interface StreamSubmitInput extends StreamRequestInput {
  conversationId: string;
}

export function useAdvisorStream() {
  // Per-action selectors. Zustand returns a stable reference for actions assigned
  // at store init, so these never re-render the caller on per-token store changes.
  const reset = useStreamStore((s) => s.reset);
  const appendToken = useStreamStore((s) => s.appendToken);
  const addToolCall = useStreamStore((s) => s.addToolCall);
  const addToolResult = useStreamStore((s) => s.addToolResult);
  const setBillingMode = useStreamStore((s) => s.setBillingMode);
  const setError = useStreamStore((s) => s.setError);
  const setDone = useStreamStore((s) => s.setDone);
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['advisor', 'stream'],
    retry: 0,
    networkMode: 'always',
    mutationFn: async (input: StreamSubmitInput) => {
      const { conversationId, ...body } = input;
      reset(conversationId);
      return readSseStream(
        resolveApiUrl(`/advisor/conversations/${conversationId}/messages/stream`),
        {
          method: 'POST',
          body: JSON.stringify(body),
          onToken: (delta) => appendToken(conversationId, delta),
          onToolCall: (call) => addToolCall(conversationId, call),
          onToolResult: (result) => addToolResult(conversationId, result),
          onNotice: (notice) => {
            // BILLING_MODE discloses whether this turn is platform-billed or BYOK
            // (wallet-billing REQ-6.5). Other notice codes are not surfaced here.
            if (
              notice.code === 'BILLING_MODE' &&
              (notice.mode === 'platform' || notice.mode === 'byok')
            ) {
              setBillingMode(conversationId, {
                mode: notice.mode,
                fellThrough: notice.fellThrough === true,
              });
            }
          },
          onError: (code) => setError(conversationId, code),
          onDone: (messageId) => setDone(conversationId, messageId),
        },
      );
    },
    onSuccess: (_data, vars) => {
      // Invalidate ONLY the conversation query — never persona/key queries, and
      // no auto-reconnect (REQ-1.16).
      queryClient.invalidateQueries({
        queryKey: ['advisor', 'conversation', vars.conversationId],
      });
    },
  });
}

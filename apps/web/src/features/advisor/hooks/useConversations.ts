// useConversations — TanStack Query hooks for the advisor conversation CRUD
// surface (design §Component 9 file list: "list query + delete/rename
// mutations"). REQ-1.9 (list), REQ-1.10 (rename), REQ-1.11 (delete).
//
// This module owns ONLY the cached conversation data. Streaming token deltas
// live in useAdvisorStream + the Zustand stream store — there is NO streaming
// logic here. Nothing in this file references a URL/route pattern; navigation
// is the caller's concern.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Conversation, ConversationListItem, Message } from '@tradr/shared/schemas/advisor';

import { api } from '@/lib/api';

import { NEW_CONVERSATION_ID } from '../stores/stream.store';

// Query-key factory. Detail key matches useAdvisorStream's invalidation target
// (['advisor', 'conversation', id]) so a streamed reply and a manual refetch
// share one cache entry.
export const conversationKeys = {
  list: () => ['advisor', 'conversations'] as const,
  detail: (id: string) => ['advisor', 'conversation', id] as const,
};

export interface ConversationListResponse {
  items: ConversationListItem[];
  nextCursor: string | null;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  nextCursor: string | null;
}

/** REQ-1.9 — list the user's conversations (newest-first, first page). */
export function useConversations() {
  return useQuery<ConversationListResponse>({
    queryKey: conversationKeys.list(),
    queryFn: () => api.get<ConversationListResponse>('/advisor/conversations'),
  });
}

/**
 * REQ-2.3 — a conversation plus its latest messages. Never fetches for the
 * new-conversation placeholder id: that transcript has no persisted messages
 * yet and renders from the stream store alone.
 */
export function useConversation(id: string) {
  return useQuery<ConversationDetail>({
    queryKey: conversationKeys.detail(id),
    queryFn: () => api.get<ConversationDetail>(`/advisor/conversations/${id}`),
    enabled: id.length > 0 && id !== NEW_CONVERSATION_ID,
  });
}

/** REQ-1.11 — delete a conversation, then drop it from the cached list. */
export function useDeleteConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/advisor/conversations/${id}`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: conversationKeys.list() });
      queryClient.removeQueries({ queryKey: conversationKeys.detail(id) });
    },
  });
}

/** REQ-1.10 — rename a conversation (PATCH /api/advisor/conversations/:id). */
export function useRenameConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<Conversation>(`/advisor/conversations/${id}`, { title }),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: conversationKeys.list() });
      queryClient.invalidateQueries({ queryKey: conversationKeys.detail(id) });
    },
  });
}

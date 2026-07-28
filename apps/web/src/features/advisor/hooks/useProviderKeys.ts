// useProviderKeys — TanStack Query hooks for the BYOK provider-key surface
// (design §Component 9; REQ-5.5, 5.6).
//
// SECURITY: the plaintext API key is NEVER cached client-side. The list query
// holds only status + masking hint (keyHintTail) — never key material — and the
// save mutation passes the plaintext straight into the PUT body without writing
// it to any query cache or hook state. Mutations invalidate the list so the UI
// reflects the new state after a save/delete.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProviderId, ProviderKeyInput, ProviderKeyListItem } from '@tradr/shared';

import { api } from '@/lib/api';

export const providerKeyKeys = {
  list: () => ['advisor', 'provider-keys'] as const,
  // GET /advisor/models — its contents track the set of configured keys, so
  // key mutations invalidate it alongside the list.
  models: () => ['advisor', 'models'] as const,
};

export interface ProviderKeyListResponse {
  items: ProviderKeyListItem[];
}

export interface SaveProviderKeyResult extends ProviderKeyListItem {
  verified: boolean;
}

/** REQ-5.5 — list the user's configured provider keys (no key material). */
export function useProviderKeys() {
  return useQuery<ProviderKeyListResponse>({
    queryKey: providerKeyKeys.list(),
    queryFn: () => api.get<ProviderKeyListResponse>('/advisor/provider-keys'),
  });
}

/**
 * REQ-5.5 — save (or replace) a provider key. The plaintext `apiKey` is sent
 * only in the PUT body; it is never returned by the API nor stored in cache.
 */
export function useSaveProviderKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, ...body }: { providerId: ProviderId } & ProviderKeyInput) =>
      api.put<SaveProviderKeyResult>(`/advisor/provider-keys/${providerId}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerKeyKeys.list() });
      queryClient.invalidateQueries({ queryKey: providerKeyKeys.models() });
    },
  });
}

/**
 * Change the default model for an already-configured key (PATCH — key material
 * is neither sent nor touched).
 */
export function useUpdateDefaultModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, defaultModel }: { providerId: ProviderId; defaultModel: string }) =>
      api.patch<ProviderKeyListItem>(`/advisor/provider-keys/${providerId}`, { defaultModel }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerKeyKeys.list() });
    },
  });
}

/** REQ-5.6 — delete a provider key, then refetch the list. */
export function useDeleteProviderKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (providerId: ProviderId) => api.delete(`/advisor/provider-keys/${providerId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerKeyKeys.list() });
      queryClient.invalidateQueries({ queryKey: providerKeyKeys.models() });
    },
  });
}

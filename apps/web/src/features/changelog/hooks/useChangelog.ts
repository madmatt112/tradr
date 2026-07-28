import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ChangelogReleasesResponse, MarkChangelogViewedResponse } from '@tradr/shared';

import { api } from '@/lib/api';

// Module-graph discipline (REQ-4.7): this file imports only @tanstack/react-query,
// @/lib/api, and types from @tradr/shared — no markdown dependencies — because the
// Sidebar (initial chunk) imports it.

export function useChangelogReleases() {
  return useQuery<ChangelogReleasesResponse>({
    queryKey: ['changelog', 'releases'],
    queryFn: () => api.get<ChangelogReleasesResponse>('/changelog/releases'),
    // 15 min matches the server TTL (REQ-4.6) — no polling that defeats the server cache.
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    // A 503 must not be hammered ×3 — the server's negative cache makes retries
    // pointless within 5 min anyway.
    retry: false,
  });
}

export function useMarkChangelogViewed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<MarkChangelogViewedResponse>('/changelog/viewed'),
    onSuccess: async (data) => {
      // The cancelQueries step is load-bearing: the page often mounts with
      // client-stale data, which starts a background refetch concurrent with
      // this POST; a GET whose DB read ran before the POST's UPDATE committed
      // but whose response lands after the patch would otherwise overwrite
      // lastViewedAt with the pre-visit floor and resurrect the just-cleared
      // badge for up to a full staleTime window.
      await queryClient.cancelQueries({ queryKey: ['changelog', 'releases'] });
      // Patch the envelope in place (clears the badge) without re-hitting the GET.
      queryClient.setQueryData<ChangelogReleasesResponse>(['changelog', 'releases'], (old) =>
        old ? { ...old, lastViewedAt: data.lastViewedAt } : old,
      );
    },
  });
}

export function hasNewReleases(data: ChangelogReleasesResponse | undefined): boolean {
  // Releases are server-sorted desc, so [0] is newest. Both sides are
  // server-emitted .toISOString() values — Component 3 canonicalizes upstream
  // timestamps and Component 5 emits Date.toISOString() — so the strings share
  // one fixed-width Z-form shape and lexicographic comparison equals instant
  // comparison; mixed-precision strings would NOT compare correctly, which is
  // why Component 3 re-serializes rather than passing GitHub's seconds-precision
  // form through. Equal timestamps are NOT new.
  return !!data && data.releases.length > 0 && data.releases[0].publishedAt > data.lastViewedAt;
}

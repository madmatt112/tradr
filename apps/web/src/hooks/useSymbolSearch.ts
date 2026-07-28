// useSymbolSearch — TanStack Query hook for the symbol autocomplete
// (design §hooks; REQ-7.1/7.3, REQ-3.x). Wraps GET /api/symbols/search.
//
// The query is disabled until at least one character is supplied so an empty
// field fires no request and surfaces no error (REQ-2.6 / empty ⇒ no
// suggestions). Retries are disabled so a search-endpoint failure renders the
// degraded state immediately rather than after backoff.

import { useQuery } from '@tanstack/react-query';

import type { SymbolSearchResponse } from '@tradr/shared';

import { api } from '@/lib/api';

export function useSymbolSearch(q: string) {
  return useQuery<SymbolSearchResponse>({
    queryKey: ['symbols', 'search', q],
    queryFn: () => api.get<SymbolSearchResponse>(`/symbols/search?${new URLSearchParams({ q })}`),
    enabled: q.length >= 1,
    retry: false,
  });
}

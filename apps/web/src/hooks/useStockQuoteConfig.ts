// useStockQuoteConfig — reports whether the platform delayed-quote provider is
// configured, gating the calculator's + dashboard widget's "pull last price"
// affordance (design §hooks; REQ-5.3/9.5). Mirrors useBillingConfig's shape plus
// the useChangelog config-caching idiom (staleTime + no refetch-on-focus). The
// shared query key ['symbols','quote-config'] means ONE cached read serves both
// consumers. A still-loading query reads as not-configured
// (data?.stockQuoteConfigured === true is false while data is undefined), so the
// affordance is absent from first paint — no flash, and no probe via a quote call.

import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

export function useStockQuoteConfig() {
  return useQuery<{ stockQuoteConfigured: boolean }>({
    queryKey: ['symbols', 'quote-config'],
    queryFn: () => api.get<{ stockQuoteConfigured: boolean }>('/symbols/quote-config'),
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

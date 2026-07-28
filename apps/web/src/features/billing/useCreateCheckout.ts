// useCreateCheckout — mutation that creates a Stripe Checkout Session and
// redirects the browser to it (design §Component 8; REQ-2.1/7).
//
// POST /api/billing/checkout { packId } → { url }. On success the browser is sent
// to Stripe's hosted Checkout via window.location (a full navigation, not SPA).

import { useMutation } from '@tanstack/react-query';

import type { CheckoutRequestInput } from '@tradr/shared';

import { api } from '@/lib/api';

export interface CheckoutResponse {
  url: string;
}

export function useCreateCheckout() {
  return useMutation({
    mutationFn: (body: CheckoutRequestInput) =>
      api.post<CheckoutResponse>('/billing/checkout', body),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
}

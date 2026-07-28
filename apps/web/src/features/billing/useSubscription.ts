// useSubscribe / useOpenPortal — Pro-subscription Checkout and Customer Portal
// mutations (design §Component 11; REQ-2.1, REQ-4.1/4.4).
//
// POST /api/billing/subscription/checkout → { url }  (Stripe-hosted Checkout)
// POST /api/billing/subscription/portal   → { url }  (Stripe Customer Portal)
//
// On success the browser is sent to the Stripe-hosted page via window.location
// (a full navigation, not SPA) — the useCreateCheckout pattern. Neither POST
// takes a body: the Price sold is server-configured (REQ-2.2).

import { useMutation } from '@tanstack/react-query';

import { api } from '@/lib/api';

interface RedirectResponse {
  url: string;
}

export function useSubscribe() {
  return useMutation({
    mutationFn: () => api.post<RedirectResponse>('/billing/subscription/checkout'),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
}

export function useOpenPortal() {
  return useMutation({
    mutationFn: () => api.post<RedirectResponse>('/billing/subscription/portal'),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
}

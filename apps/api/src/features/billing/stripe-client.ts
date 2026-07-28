import Stripe from 'stripe';

import { config, isStripeConfigured } from '@/lib/config';

// ---------------------------------------------------------------------------
// The ONE Stripe client seam (plan-tiers design Component 4). Hoisted from its
// module-private home in `billing.service.ts` — pinned here because the webhook
// integration tests stub the Stripe client at exactly this module, so the
// module home decides the test architecture. Behaviour unchanged.
// ---------------------------------------------------------------------------

/**
 * Lazily construct the guarded Stripe client. Returns `null` when Stripe is not
 * configured — the client is NEVER constructed without `STRIPE_SECRET_KEY`
 * (graceful absence, REQ-10.2). Callers translate `null` into a stable
 * `402 BILLING_NOT_AVAILABLE`.
 */
export function getStripeClient(): Stripe | null {
  if (!isStripeConfigured() || !config.STRIPE_SECRET_KEY) return null;
  return new Stripe(config.STRIPE_SECRET_KEY);
}

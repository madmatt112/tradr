import type { CreditPack } from '@tradr/shared';

// Server-authoritative credit-pack catalog (design.md §Component 2, REQ-2.2/2.3).
//
// The client selects a pack by `id` only; the price charged (`priceMinor`) and
// the credits granted come SOLELY from this config — never from client input.
//
// `credits` is a bigint micro-USD numeric string (1 credit = 1 micro-USD, see
// Component 3 / wallet.ts `creditUnits`). `priceMinor` is the Stripe charge
// amount in the currency's minor unit (cents for usd).
export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: 'pack_10', label: '$10', priceMinor: 1000, currency: 'usd', credits: '10000000' },
  { id: 'pack_25', label: '$25', priceMinor: 2500, currency: 'usd', credits: '25000000' },
  { id: 'pack_50', label: '$50', priceMinor: 5000, currency: 'usd', credits: '50000000' },
  { id: 'pack_100', label: '$100', priceMinor: 10000, currency: 'usd', credits: '100000000' },
] as const;

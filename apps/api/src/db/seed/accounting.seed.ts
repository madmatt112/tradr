// Req 6.4: a future seed script that closes positions must decide whether to
// call `bootstrap()` from `@/features/accounting/bootstrap` so the registered
// close-hook fires and produces the corresponding ledger entries. Until such a
// script exists, these placeholders intentionally produce zero rows — the v1
// empty-ledger / empty-state guarantee depends on it.

export async function seedLedger() {
  return [] as const;
}

export async function seedExchangeRates() {
  return [] as const;
}

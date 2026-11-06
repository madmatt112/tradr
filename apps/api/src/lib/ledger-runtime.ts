import Decimal from 'decimal.js';

import {
  insertPositionCloseLedgerEntries,
  postFillLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import {
  assertLedgerHooksCoRegistered,
  replaceCloseHook,
  replaceFillHook,
  replaceReverseHook,
} from '@/features/positions/positions.service';

/**
 * The ledger half of process bootstrap (design C11, Req 9.3): the `Decimal`
 * pin and the three co-registered ledger hooks, split out of `app.ts` so the
 * operator CLI (`tradr positions expire`) can run them without the rest of
 * `bootstrap()` — which also runs migrations and is never appropriate for a
 * one-shot command. `replace*Hook` (not `register*Hook`) keeps this
 * idempotent: calling it twice, from the HTTP server's `bootstrap()` and
 * separately from the CLI's own process, just overwrites.
 */
export function initLedgerRuntime(): void {
  Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20 });
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
  replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
  replaceFillHook('ledger', postFillLedgerEntries);
  assertLedgerHooksCoRegistered();
}

// RetentionSummary — the survival and money lines both deletion dialogs share
// (design §C11, Req 7.6).
//
// These lines are EXTRACTS of the docs page (user-guide/account-deletion.mdx,
// task 15): the dialog states the few facts a user must weigh before confirming,
// and the docs link carries the full statement under its stable heading. Keep
// the two in step — a fact added here that is not on the page, or the reverse,
// is a drift the page's own review should catch.
//
// The unused credit balance is a PROP, not a hook read: self-service passes
// `useWalletBalance`'s balance and admin passes the target's `walletBalance`, so
// this component stays presentation-only and testable without either query.

import { Numeric } from '@/components/Numeric';
import { docsUrl } from '@/lib/docs';

export interface RetentionSummaryProps {
  /**
   * Unused wallet-credit balance as a credit-unit string (1 credit = 1
   * micro-USD), or `undefined` while the source query is still loading — in
   * which case the money line drops the figure but still states credits are not
   * refunded.
   */
  creditBalance?: string;
}

export function RetentionSummary({ creditBalance }: RetentionSummaryProps) {
  return (
    <div className="space-y-3 text-sm" data-testid="retention-summary">
      <div>
        <p className="font-medium">What deletion keeps</p>
        <ul className="text-muted-foreground mt-1 list-disc space-y-1 pl-5">
          <li>Stripe keeps its customer and invoice records.</li>
          <li>An audit-log row stays, with the user reference nulled and the email hashed.</li>
          <li>One tombstone row stays, so the account cannot be deleted a second time.</li>
          <li>Backups keep a copy of the account until each backup expires.</li>
        </ul>
      </div>

      <div>
        <p className="font-medium">Your money</p>
        <ul className="text-muted-foreground mt-1 list-disc space-y-1 pl-5">
          <li>
            Deletion is not refunded. A scheduled deletion keeps the paid tier until the period
            ends, without a refund.
          </li>
          <li data-testid="retention-credits">
            {creditBalance === undefined ? (
              'Unused wallet credits are deleted with the account, not refunded.'
            ) : (
              <>
                <Numeric value={creditBalance} kind="integer" direction="none" /> unused wallet
                credits are deleted with the account, not refunded.
              </>
            )}
          </li>
        </ul>
      </div>

      <p className="text-muted-foreground">
        <a
          href={docsUrl('accountDeletion')}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          What deletion removes and what it keeps
        </a>
      </p>
    </div>
  );
}

// DemoBanner — the standing "these figures are sample data" notice (R9.4).
//
// IT IS MOUNTED IN THE AUTHENTICATED LAYOUT, NOT ON THE DASHBOARD. Sample data
// reaches every derived surface in the app — the dashboard, positions,
// performance, the accounting ledger — because no aggregate filters by account.
// A notice that only appeared on the dashboard would let a user read a
// performance page of invented figures with nothing on screen to say so, which
// is the exact failure R9.4 exists to prevent.
//
// IT CARRIES THE REMOVAL ACTION, and that is the requirement rather than a
// convenience: the notice and the way out are the same control, so a user who
// has seen enough never has to go looking for the switch. One click, no confirm
// (R9.5) — the data is disposable by construction, it is regenerated identically
// by seeding again, and a confirmation step on a reversible action about
// invented trades is friction that teaches the user to click through dialogs.
//
// `info`, NEVER the gain/loss tokens. This is a system-status notice about the
// provenance of the figures, not a statement about money direction. Borrowing
// the financial-semantic palette here would colour a neutral notice as though it
// were a P&L, which is the one thing those tokens must never say.

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useDemoAccount } from '../hooks/useDemoAccount';

export function DemoBanner() {
  const { isDemoPresent, teardown, isPending } = useDemoAccount();

  // Nothing at all for the overwhelming majority of users, including while the
  // accounts read is still in flight. A placeholder would be a claim about
  // sample data we cannot yet substantiate.
  if (!isDemoPresent) return null;

  return (
    <Alert
      data-testid="demo-banner"
      // The primitive hardcodes `role="alert"`, which is assertive. This banner
      // is persistent and mounts on every navigation, so it announces itself
      // politely instead — the same softening the accounts cap banner uses.
      aria-live="polite"
      // Stacked on a phone, one row from `sm` up; the action never shrinks the
      // prose and the prose never squeezes the action.
      className="mb-4 flex flex-col items-start gap-3 border-info/20 bg-info/10 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <AlertTitle>You are looking at sample data</AlertTitle>
        <AlertDescription>
          Every figure on screen comes from a sample account, not from trades you have recorded.
          Remove it when you are ready to enter your own.
        </AlertDescription>
      </div>
      <Button
        variant="outline"
        data-testid="demo-banner-remove"
        className="w-full shrink-0 cursor-pointer motion-reduce:transition-none sm:w-auto"
        // A sub-second in-flight window with nothing to explain and no choice to
        // lose, so the plain attribute is right here — unlike an inert state the
        // user could act on, which stays focusable and states its reason.
        disabled={isPending}
        onClick={() => teardown()}
      >
        Remove sample data
      </Button>
    </Alert>
  );
}

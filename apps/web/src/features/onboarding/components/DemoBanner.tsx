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

/** The stated reason the remove button points at while its teardown is in flight. */
const REMOVAL_NOTE_ID = 'demo-banner-removal-note';

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
        {/* Teardown drops a whole account's worth of positions, fills and ledger
            rows, so it is long enough to need saying. `role="status"` because it
            appears and disappears under the user while the rest of the screen
            carries on — the same arrangement `ZeroState` uses for seeding. */}
        {isPending && (
          <p
            id={REMOVAL_NOTE_ID}
            role="status"
            data-testid="demo-banner-removal-note"
            className="mt-1 text-sm text-muted-foreground"
          >
            Removing sample data. The figures on screen clear as soon as it lands.
          </p>
        )}
      </div>
      {/* NO `disabled` ATTRIBUTE ON THIS CONTROL, in flight or otherwise — the
          rule the comment above cites is a rule about THIS button too. `disabled`
          drops it out of the tab order mid-action and blurs the focus the user
          just spent a keystroke placing on it, so a keyboard user is thrown back
          to the top of the document by the very click they made. The
          focusable-but-inert `aria-disabled` + stated-reason pattern is what
          `ZeroState`'s sample-data control and the sidebar's in-flight
          Performance link both use. */}
      <Button
        variant="outline"
        data-testid="demo-banner-remove"
        className="w-full shrink-0 cursor-pointer motion-reduce:transition-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 sm:w-auto"
        aria-disabled={isPending || undefined}
        aria-describedby={isPending ? REMOVAL_NOTE_ID : undefined}
        // The guard, not just the styling — an `aria-disabled` control is still
        // clickable and still activates on Enter, which is the price of leaving
        // it reachable.
        onClick={() => {
          if (isPending) return;
          teardown();
        }}
      >
        Remove sample data
      </Button>
    </Alert>
  );
}

// DeleteAccountSection — the "Delete account" block on the Account settings tab,
// rendered below Log out (design §C11, Req 8.1/8.4).
//
// It reads the deletion status and renders one of four states:
//   - loading            → a skeleton;
//   - status read failed  → an inline error with a retry;
//   - scheduled           → the scheduled date and a neutral "Cancel deletion"
//                           control; a failed cancel keeps the state and turns
//                           the same button into the retry (Req 8.4);
//   - pending/cancelling/firing → a neutral, in-progress line, no control;
//   - no schedule         → the destructive "Delete account" button and dialog.
//
// Destructive styling is only ever on the delete action.

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { useCancelDeletion, useDeletionStatus } from '../hooks/useAccountDeletion';

import { DeleteAccountDialog } from './DeleteAccountDialog';

function Section({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-3" data-slot="delete-account-section">
      <h3 className="text-sm font-medium">Delete account</h3>
      {children}
    </section>
  );
}

export function DeleteAccountSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const status = useDeletionStatus();
  const cancel = useCancelDeletion();

  if (status.isLoading) {
    return (
      <Section>
        <Skeleton className="h-9 w-40" />
      </Section>
    );
  }

  if (status.isError) {
    return (
      <Section>
        <p className="text-destructive text-sm">Could not load your account-deletion status.</p>
        <Button variant="outline" className="cursor-pointer" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </Section>
    );
  }

  const state = status.data?.state ?? null;
  const scheduledFor = status.data?.scheduledFor ?? null;

  if (state === 'scheduled') {
    return (
      <Section>
        <p className="text-sm" data-testid="deletion-scheduled">
          Deletion scheduled for{' '}
          {scheduledFor
            ? new Date(scheduledFor).toLocaleDateString()
            : 'the end of your paid period'}
          .
        </p>
        {cancel.isError && (
          <p className="text-destructive text-sm" role="alert">
            Could not cancel the deletion. Try again.
          </p>
        )}
        <Button
          variant="outline"
          className="cursor-pointer"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
        >
          {cancel.isPending ? 'Cancelling…' : 'Cancel deletion'}
        </Button>
      </Section>
    );
  }

  if (state === 'pending' || state === 'cancelling' || state === 'firing') {
    return (
      <Section>
        <p className="text-muted-foreground text-sm" data-testid="deletion-in-progress">
          Deletion in progress.
        </p>
      </Section>
    );
  }

  return (
    <Section>
      <p className="text-muted-foreground text-sm">
        Permanently delete your account and its data. This cannot be undone.
      </p>
      <Button variant="destructive" className="cursor-pointer" onClick={() => setDialogOpen(true)}>
        Delete account
      </Button>
      {dialogOpen && <DeleteAccountDialog onClose={() => setDialogOpen(false)} />}
    </Section>
  );
}

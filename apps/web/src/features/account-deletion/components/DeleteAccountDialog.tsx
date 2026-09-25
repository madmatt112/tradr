// DeleteAccountDialog — the confirmation in front of self-service deletion
// (design §C11, Req 8.1/8.2).
//
// It carries the RetentionSummary (what survives, the money facts, the docs
// link), a timing line read from the billing tier, and the password gate. The
// confirm is destructive; every other control is neutral. Every server refusal
// keeps the dialog open with one message per code (Req 8.2) so the user can
// correct and retry without losing the typed password.

import { useState } from 'react';

import { RetentionSummary } from '@/components/account-deletion/RetentionSummary';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTierState } from '@/features/billing/useTierState';
import { useWalletBalance } from '@/features/billing/useWalletBalance';

import { useDeleteAccount } from '../hooks/useAccountDeletion';

// One message per code in Req 8.2, plus 409 DELETION_IN_PROGRESS. Anything else
// (a bare 500, an unmapped code) falls back to the neutral line below.
const DELETE_ERROR_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'That password is not valid. Check it and try again.',
  INVALID_PASSWORD: 'That password is incorrect.',
  LAST_ADMIN: 'You are the last admin. Make another user an admin before deleting your account.',
  SUBSCRIPTION_UNRESOLVED:
    'Your subscription cannot be resolved right now — billing is unavailable. Try again later.',
  RATE_LIMITED: 'Too many attempts. Try again in a few minutes.',
  STRIPE_CANCEL_FAILED: 'Your subscription could not be updated. Nothing was deleted — try again.',
  DELETION_IN_PROGRESS: 'A deletion is already in progress.',
};

const FALLBACK_DELETE_ERROR = 'Something went wrong. Nothing was deleted — try again.';

function deleteErrorMessage(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null
      ? (err as { error?: { code?: string } }).error?.code
      : undefined;
  return (code && DELETE_ERROR_MESSAGES[code]) || FALLBACK_DELETE_ERROR;
}

interface DeleteAccountDialogProps {
  /** Called on a scheduled outcome or when the user dismisses the dialog. */
  onClose: () => void;
}

export function DeleteAccountDialog({ onClose }: DeleteAccountDialogProps) {
  const [password, setPassword] = useState('');
  const balance = useWalletBalance();
  const tier = useTierState();
  const del = useDeleteAccount();

  // Timing (design §C11): a live subscription whose paid period ends in the
  // future defers the delete to that date; otherwise it fires immediately.
  const subscription = tier.data?.subscription ?? null;
  const periodEnd = subscription ? new Date(subscription.currentPeriodEnd) : null;
  const timingLine =
    periodEnd !== null && periodEnd.getTime() > Date.now()
      ? `Your account will be deleted on ${periodEnd.toLocaleDateString()}, when your paid period ends. It stays usable until then, and you can cancel before it fires.`
      : 'Your account will be deleted immediately. This cannot be undone.';

  const submit = () => {
    if (password.length === 0 || del.isPending) return;
    del.mutate(
      { password },
      {
        // `deleted` navigates away; `scheduled` leaves the user signed in, so
        // close the dialog and let the settings section show the scheduled
        // state (Req 8.3). Errors keep the dialog open (no onClose).
        onSuccess: (result) => {
          if (result.outcome === 'scheduled') onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !del.isPending) onClose();
      }}
    >
      <DialogContent data-testid="delete-account-dialog">
        <DialogHeader>
          <DialogTitle>Delete account</DialogTitle>
          <DialogDescription>{timingLine}</DialogDescription>
        </DialogHeader>

        <RetentionSummary creditBalance={balance.data?.balance} />

        <div className="space-y-2">
          <Label htmlFor="delete-account-password">Confirm your password</Label>
          <Input
            id="delete-account-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {del.isError && (
          <p className="text-destructive text-sm" role="alert" data-testid="delete-account-error">
            {deleteErrorMessage(del.error)}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={onClose}
            disabled={del.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="cursor-pointer"
            disabled={password.length === 0 || del.isPending}
            onClick={submit}
          >
            {del.isPending ? 'Deleting…' : 'Delete my account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

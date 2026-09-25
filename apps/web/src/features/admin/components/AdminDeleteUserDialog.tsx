// AdminDeleteUserDialog — the confirmation in front of the admin Delete action
// (design §C11, Req 6.4/7.6).
//
// It mirrors FactoryResetDialog: the typed email is the safety mechanism and the
// server re-checks it before anything is deleted, so this dialog is the
// usability layer, not the guard. It carries the shared RetentionSummary (what
// survives, the money facts, the docs link) fed the TARGET's unused credit
// balance from useAdminUser, and a typed-email gate on the destructive confirm.
//
// Every server refusal keeps the dialog open with one message per code (Req 6.4)
// so the operator can retry — the confirm button IS the retry — without
// re-typing the address. 502 STRIPE_CANCEL_FAILED is the fail-closed case: the
// live subscription could not be cancelled and nothing was deleted.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { AdminUserListItem } from '@tradr/shared/schemas/admin';

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

import { useAdminDeleteUser } from '../hooks/useAdminDeleteUser';
import { useAdminUser } from '../hooks/useAdminUser';

// One message per code the delete route returns (Req 6.4); anything unmapped
// falls back to the neutral line. Every case here left the account intact.
const DELETE_ERROR_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'The typed email does not match the account. Nothing was deleted.',
  NOT_FOUND: 'This user no longer exists. Nothing was deleted.',
  LAST_ADMIN: 'Cannot delete the last admin.',
  SUBSCRIPTION_UNRESOLVED:
    'Their subscription cannot be resolved right now — billing is unavailable. Nothing was deleted; try again later.',
  RATE_LIMITED: 'Too many attempts. Try again in a few minutes.',
  STRIPE_CANCEL_FAILED:
    'Their subscription could not be cancelled. Nothing was deleted — try again.',
};

const FALLBACK_DELETE_ERROR = 'Something went wrong. Nothing was deleted — try again.';

function deleteErrorMessage(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null
      ? (err as { error?: { code?: string } }).error?.code
      : undefined;
  return (code && DELETE_ERROR_MESSAGES[code]) || FALLBACK_DELETE_ERROR;
}

interface AdminDeleteUserDialogProps {
  /** The user to delete, or `null` when the dialog is closed. */
  user: AdminUserListItem | null;
  onClose: () => void;
}

export function AdminDeleteUserDialog({ user, onClose }: AdminDeleteUserDialogProps) {
  const [typedEmail, setTypedEmail] = useState('');
  const detail = useAdminUser(user?.id);
  const del = useAdminDeleteUser();

  // Start clean for every user the dialog is opened on: a typed address (or a
  // stale error) carried across a close would mean the confirm was armed, or the
  // last failure was showing, the next time it opened — on a different row.
  useEffect(() => {
    setTypedEmail('');
    del.reset();
  }, [user?.id]);

  // Case-insensitive, as the server compares it: an operator reading the address
  // off the row should not be defeated by a capital letter.
  const confirmed =
    user !== null && typedEmail.trim().toLowerCase() === user.email.toLowerCase().trim();

  const submit = () => {
    if (!user || !confirmed || del.isPending) return;
    del.mutate(
      { userId: user.id, confirmEmail: typedEmail.trim() },
      {
        onSuccess: () => {
          toast.success(`Deleted ${user.email}.`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open && !del.isPending) onClose();
      }}
    >
      <DialogContent data-testid="admin-delete-user-dialog">
        <DialogHeader>
          <DialogTitle>Delete {user?.email}</DialogTitle>
          <DialogDescription>
            This permanently deletes the user and all their data. It cannot be undone, and no backup
            is taken.
          </DialogDescription>
        </DialogHeader>

        <RetentionSummary creditBalance={detail.data?.walletBalance} />

        <div className="space-y-2">
          <Label htmlFor="confirm-delete-email">
            Type <span className="font-mono">{user?.email}</span> to confirm
          </Label>
          <Input
            id="confirm-delete-email"
            autoComplete="off"
            value={typedEmail}
            onChange={(e) => setTypedEmail(e.target.value)}
            placeholder={user?.email}
          />
        </div>

        {del.isError && (
          <p className="text-destructive text-sm" role="alert" data-testid="admin-delete-error">
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
            disabled={!confirmed || del.isPending}
            onClick={submit}
          >
            {del.isPending ? 'Deleting…' : 'Delete this account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

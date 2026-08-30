// FactoryResetDialog — the confirmation in front of the admin surface's one
// destructive action.
//
// THE DIALOG IS NOT THE SAFETY MECHANISM. The typed email is re-checked by the
// service before anything is deleted, so this component is what makes the guard
// usable, not what makes it a guard. It is written on that assumption: nothing
// here is load-bearing, and nothing here needs to be defended against a caller
// who skips it.
//
// What it IS for is the operator noticing they are about to reset the wrong
// account. Three things do that work, in the order they are read:
//
//  1. THE COUNTS. "Cannot be undone" is a sentence anyone can click past.
//     "3 accounts · 47 positions · 112 fills" is the same statement in a form
//     that can be checked against the account they think they are looking at,
//     and it is the last moment such a check is possible.
//  2. WHAT SURVIVES, said as plainly as what does not. An operator who is unsure
//     whether this cancels a subscription or burns a wallet balance will click
//     nothing, and be right to.
//  3. THE TYPED ADDRESS. Deliberately not a checkbox: the point is to make the
//     hand type the identity of the row, so a reset aimed at the wrong user
//     fails at the keyboard rather than at the confirm button.
//
// The settings switch is "Remove user settings?" and defaults OFF, so the
// conservative half is what a hurried operator gets.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { AdminUserListItem } from '@tradr/shared/schemas/admin';

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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

import { useFactoryReset, useResetPreview } from '../hooks/useFactoryReset';

interface FactoryResetDialogProps {
  /** The user to reset, or `null` when the dialog is closed. */
  user: AdminUserListItem | null;
  onClose: () => void;
}

/** "3 accounts", "1 position" — a count with its unit, or nothing at zero. */
function countLabel(n: number, singular: string, plural = `${singular}s`): string | null {
  if (n === 0) return null;
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

export function FactoryResetDialog({ user, onClose }: FactoryResetDialogProps) {
  const [typedEmail, setTypedEmail] = useState('');
  const [removeSettings, setRemoveSettings] = useState(false);

  const preview = useResetPreview(user?.id);
  const reset = useFactoryReset();

  // Both inputs start clean for every user the dialog is opened on. Carrying a
  // typed address across a close would mean the confirm button was already armed
  // the next time it opened — on a different row.
  useEffect(() => {
    setTypedEmail('');
    setRemoveSettings(false);
  }, [user?.id]);

  const tradingCounts = preview.data
    ? [
        countLabel(preview.data.tradingData.accounts, 'account'),
        countLabel(preview.data.tradingData.positions, 'position'),
        countLabel(preview.data.tradingData.fills, 'fill'),
        countLabel(preview.data.tradingData.ledgerEntries, 'ledger entry', 'ledger entries'),
        countLabel(preview.data.tradingData.expenses, 'expense'),
        countLabel(preview.data.tradingData.brokerages, 'custom brokerage'),
      ].filter((label): label is string => label !== null)
    : [];

  const settingsCounts = preview.data
    ? [
        countLabel(preview.data.settings.providerKeys, 'AI provider key'),
        countLabel(preview.data.settings.externalApiKeys, 'external API key'),
        countLabel(preview.data.settings.advisorPersonas, 'advisor persona'),
        countLabel(preview.data.settings.advisorConversations, 'advisor conversation'),
        countLabel(preview.data.settings.dashboardLayouts, 'dashboard layout'),
      ].filter((label): label is string => label !== null)
    : [];

  // Case-insensitive, as the server compares it: an operator reading the address
  // off the row above should not be defeated by a capital letter.
  const confirmed =
    user !== null && typedEmail.trim().toLowerCase() === user.email.toLowerCase().trim();

  const submit = () => {
    if (!user || !confirmed) return;
    reset.mutate(
      { userId: user.id, confirmEmail: typedEmail.trim(), removeSettings },
      {
        onSuccess: (result) => {
          const total = Object.values(result.deleted).reduce((sum, n) => sum + n, 0);
          toast.success(
            `Reset ${result.email} — ${total.toLocaleString()} ${total === 1 ? 'row' : 'rows'} deleted.`,
          );
          onClose();
        },
        onError: () => {
          toast.error('The reset failed. Nothing was deleted.');
        },
      },
    );
  };

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open && !reset.isPending) onClose();
      }}
    >
      <DialogContent data-testid="factory-reset-dialog">
        <DialogHeader>
          <DialogTitle>Factory reset {user?.email}</DialogTitle>
          <DialogDescription>
            This returns the account to the state it was in just after registering. It cannot be
            undone, and no backup is taken.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div>
            <p className="font-medium">Permanently deletes</p>
            {preview.isLoading && <Skeleton className="mt-2 h-5 w-full" />}
            {preview.isError && (
              <p className="text-destructive mt-1">
                Could not read what this would delete. Not safe to continue — close and try again.
              </p>
            )}
            {preview.data && (
              <p className="text-muted-foreground mt-1" data-testid="reset-trading-counts">
                {tradingCounts.length > 0
                  ? tradingCounts.join(' · ')
                  : 'Nothing — no trading data.'}
              </p>
            )}
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="remove-settings" className="cursor-pointer font-medium">
                Remove user settings?
              </Label>
              <p className="text-muted-foreground mt-1" data-testid="reset-settings-counts">
                {removeSettings
                  ? settingsCounts.length > 0
                    ? `Also deletes ${settingsCounts.join(' · ')}, and resets their preferences.`
                    : 'Also resets their preferences. There is nothing else stored.'
                  : 'Keeps their API keys, advisor data, dashboard layout and preferences.'}
              </p>
            </div>
            <Switch
              id="remove-settings"
              className="cursor-pointer"
              checked={removeSettings}
              onCheckedChange={setRemoveSettings}
            />
          </div>

          {/* Said whether or not settings are included: the two most alarming
              things an operator might fear this touches are the two it never
              touches, and leaving that to be inferred is how a useful button
              goes unused. */}
          <p className="text-muted-foreground">
            Billing, subscription and wallet credit are never affected. Their login, password and
            email verification are kept, and the onboarding walkthrough is reset either way.
          </p>

          <div className="space-y-2">
            <Label htmlFor="confirm-email">
              Type <span className="font-mono">{user?.email}</span> to confirm
            </Label>
            <Input
              id="confirm-email"
              autoComplete="off"
              value={typedEmail}
              onChange={(e) => setTypedEmail(e.target.value)}
              placeholder={user?.email}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={onClose}
            disabled={reset.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="cursor-pointer"
            // Gated on the preview too: a reset fired while the counts are
            // unknown is one the operator was never shown the size of.
            disabled={!confirmed || reset.isPending || !preview.data}
            onClick={submit}
          >
            {reset.isPending ? 'Resetting…' : 'Reset this account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

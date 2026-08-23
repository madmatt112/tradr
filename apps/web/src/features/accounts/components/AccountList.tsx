import { useState } from 'react';

import type { Account } from '@tradr/shared';

import { PageHeader } from '@/components/layout/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { writabilityRestricted } from '@/features/billing/tier-usage';
import { UpgradeLink } from '@/features/billing/UpgradeLink';
import { useTierState } from '@/features/billing/useTierState';
import { useDemoAccount } from '@/features/onboarding/hooks/useDemoAccount';

import { useAccounts, useDeleteAccount, useSetWritableAccount } from '../hooks/useAccounts';

import { AccountDialog } from './AccountDialog';

export function AccountList() {
  const { data: accounts, isLoading } = useAccounts();
  const deleteAccount = useDeleteAccount();
  const setWritable = useSetWritableAccount();
  const { data: tierState } = useTierState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);

  // Sample data and real accounts are mutually exclusive, and this is the only
  // place in the app a second account can be started, so this is where "begins
  // creating a real account" happens. The server refuses
  // the create outright while sample data is present, so without this the user
  // would fill in the whole form and be told no; asking first, once, and
  // clearing the way is the difference between a rule and a wall.
  const { isDemoPresent, teardown, isPending: isTearingDown } = useDemoAccount();
  const [demoConfirmOpen, setDemoConfirmOpen] = useState(false);
  const [demoTeardownFailed, setDemoTeardownFailed] = useState(false);

  function beginCreate(): void {
    setEditAccount(null);
    if (isDemoPresent) {
      setDemoConfirmOpen(true);
      return;
    }
    setDialogOpen(true);
  }

  // Writability designation (plan-tiers D18/REQ-6.6): badges + the
  // make-writable action appear only while the restriction is active
  // (over-cap ∧ free ∧ gated) — nothing renders on self-host/Pro/admin.
  const restricted = writabilityRestricted(tierState);
  const writableAccountId = tierState?.usage?.accounts.writableAccountId ?? null;

  // L1 cap-edge banner (REQ-6.4/11.6): usage is populated only when gating is
  // on and the user is non-exempt, so its presence carries the gating leg;
  // `null` caps (unlimited) never banner.
  const accountsCap = tierState?.usage ? tierState.limits[tierState.tier].accounts : null;
  const accountsUsed = tierState?.usage?.accounts.used ?? 0;
  const atCap = accountsCap !== null && accountsUsed >= accountsCap;

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <>
      {/* The walkthrough's account set opens here, so the New Account button is
          its first step's anchor — the same `data-tour` contract the positions
          list and the account dialog already use. */}
      <PageHeader
        page="Accounts"
        right={
          <Button className="cursor-pointer" data-tour="account-new" onClick={beginCreate}>
            New Account
          </Button>
        }
      />

      {atCap && (
        <Alert
          data-testid="accounts-cap-banner"
          aria-live="polite"
          className="mb-4 flex items-start justify-between gap-4"
        >
          <div>
            <AlertTitle>Account limit reached</AlertTitle>
            <AlertDescription>
              You&apos;re using {accountsUsed} of {accountsCap} account
              {accountsCap === 1 ? '' : 's'} on your plan.
              {restricted ? ' Only the writable account accepts new positions.' : ''}
            </AlertDescription>
          </div>
          {tierState?.purchasable && <UpgradeLink surface="accounts" className="shrink-0" />}
        </Alert>
      )}

      {!accounts?.length ? (
        <div className="py-12 text-center text-muted-foreground">
          No accounts yet. Create one to start tracking positions.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <span>{account.name}</span>
                    {/* Writability badge + make-writable action (D18) — only
                        while the restriction is active; the action is the
                        in-place remedy instead of a 403 at position create. */}
                    {restricted &&
                      (account.id === writableAccountId ? (
                        <Badge variant="secondary" data-testid={`writable-badge-${account.id}`}>
                          Writable
                        </Badge>
                      ) : (
                        <>
                          <Badge variant="outline" data-testid={`readonly-badge-${account.id}`}>
                            Read-only
                          </Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            className="cursor-pointer"
                            disabled={setWritable.isPending}
                            onClick={() => setWritable.mutate(account.id)}
                          >
                            Make writable
                          </Button>
                        </>
                      ))}
                  </div>
                </TableCell>
                <TableCell>{account.currency}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="cursor-pointer">
                        ⋯
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => {
                          setEditAccount(account);
                          setDialogOpen(true);
                        }}
                      >
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive"
                        onClick={() => setDeleteTarget(account)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AccountDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditAccount(null);
        }}
        account={editAccount}
      />

      {/* Confirm ONCE, then tear the sample data down, then open the form.
          The teardown is what makes the create possible, so it runs first and the
          dialog opens on its success.

          THE DIALOG STAYS OPEN UNTIL THE TEARDOWN SETTLES, and that is the whole
          point of the `preventDefault`. Radix closes an `AlertDialogAction` on
          activation, so the confirmation used to disappear while the request was
          still in flight — leaving nothing on screen to say anything was
          happening, and "New Account" live again underneath it. A second click
          re-opened this dialog and fired a second teardown: the data survives,
          because teardown is idempotent server-side, but the user is shown the
          same destructive confirmation twice for one action, which teaches them
          the first one did not take. Held open, there is no second entrance.

          A FAILURE IS SAID HERE, not only in the toast the hook raises. The
          request can reject partway; before this, that left the user with a
          closed dialog, no form, and a toast they may have missed — the state
          they started in with no explanation in it. Now the confirmation is
          still up, says what happened, and the same button is the retry. */}
      <AlertDialog
        open={demoConfirmOpen}
        onOpenChange={(open) => {
          if (open) return;
          // Escape, the overlay and Cancel all arrive here. None of them may
          // close a confirmation whose action is still running.
          if (isTearingDown) return;
          setDemoConfirmOpen(false);
          setDemoTeardownFailed(false);
        }}
      >
        <AlertDialogContent data-testid="demo-teardown-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the sample data?</AlertDialogTitle>
            <AlertDialogDescription>
              Your own accounts and the sample account cannot both exist, so creating an account
              removes the sample account and every trade in it. You can add sample data again once
              you have no accounts of your own.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {demoTeardownFailed && (
            <p role="alert" data-testid="demo-teardown-error" className="text-sm text-destructive">
              The sample data could not be removed, so your account has not been created. Try again.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              className="cursor-pointer"
              aria-disabled={isTearingDown || undefined}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              aria-disabled={isTearingDown || undefined}
              onClick={(event) => {
                // Hold the dialog open across the request; Radix would close it.
                event.preventDefault();
                if (isTearingDown) return;
                setDemoTeardownFailed(false);
                teardown({
                  onSuccess: () => {
                    setDemoConfirmOpen(false);
                    setDialogOpen(true);
                  },
                  onError: () => setDemoTeardownFailed(true),
                });
              }}
            >
              {isTearingDown ? 'Removing…' : 'Remove and continue'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={() => {
                if (deleteTarget) {
                  deleteAccount.mutate(deleteTarget.id);
                  setDeleteTarget(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

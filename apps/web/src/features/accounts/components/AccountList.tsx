import { useState } from 'react';

import type { Account } from '@tradr/shared';

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

  // Sample data and real accounts are mutually exclusive (user-onboarding R9.6),
  // and this is the only place in the app a second account can be started, so
  // this is where "begins creating a real account" happens. The server refuses
  // the create outright while sample data is present, so without this the user
  // would fill in the whole form and be told no; asking first, once, and
  // clearing the way is the difference between a rule and a wall.
  const { isDemoPresent, teardown } = useDemoAccount();
  const [demoConfirmOpen, setDemoConfirmOpen] = useState(false);

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
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Accounts</h1>
        <Button className="cursor-pointer" onClick={beginCreate}>
          New Account
        </Button>
      </div>

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

      {/* R9.6 — confirm once, then tear the sample data down, then open the form.
          The teardown is what makes the create possible, so it runs first and
          the dialog opens on its success; if it fails, its own toast says so and
          no half-started form is left on screen. */}
      <AlertDialog
        open={demoConfirmOpen}
        onOpenChange={(open) => !open && setDemoConfirmOpen(false)}
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
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={() => teardown({ onSuccess: () => setDialogOpen(true) })}
            >
              Remove and continue
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

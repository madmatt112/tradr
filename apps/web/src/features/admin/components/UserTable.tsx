// UserTable — paginated admin user table (design §Component 11; REQ-3.1/3.2/
// 3.3/3.4, REQ-7.4, REQ-7.6).
//
// - Cursor pagination, newest first: each loaded page stays mounted as its own
//   <UserTableRows cursor={…}> so a toggle's ['admin','users'] invalidation
//   refetches every visible page, not just the last one. "Load more" appends
//   the next cursor.
// - "Last seen" carries the honesty tooltip ("last recorded session activity —
//   may be arbitrarily old") and renders `—` for never-active users (NULL).
// - The admin toggle is a Switch that ONLY opens a confirm Dialog — the
//   mutation fires exclusively from the dialog's confirm button, with
//   extra-explicit copy when an admin is removing their own access.
// - LAST_ADMIN (409) surfaces as an inline dialog error + toast ("Cannot
//   remove the last admin"); the error code is read at err.error?.code (the
//   house envelope the api client throws).
// - Row "Details" opens a dialog over useAdminUser (positions, advisor turns,
//   usage sums, wallet balance).
// - Row "Reset" opens <FactoryResetDialog>, which owns the whole destructive
//   flow (preview counts, the settings switch, the typed-email confirmation).
//   This component only decides WHICH user it is about — the confirmation that
//   matters is enforced server-side either way.

import { Check, Info } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminUserListItem } from '@tradr/shared/schemas/admin';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/useAuth';

import { useAdminUser } from '../hooks/useAdminUser';
import { useAdminUsers } from '../hooks/useAdminUsers';
import { useToggleAdmin } from '../hooks/useToggleAdmin';
import { formatMicroUsd } from '../lib/format';

import { FactoryResetDialog } from './FactoryResetDialog';

const LAST_SEEN_CAVEAT = 'Last recorded session activity — may be arbitrarily old';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

// House envelope: the api client throws the parsed JSON body with `status`
// patched on — the code lives at err.error?.code, never err.code here.
function getErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

interface RowActions {
  onToggle: (user: AdminUserListItem) => void;
  onDetails: (user: AdminUserListItem) => void;
  onReset: (user: AdminUserListItem) => void;
}

// One mounted component per loaded page so every page refetches on
// invalidation (the cache is shared with the parent's nextCursor query).
function UserTableRows({ cursor, onToggle, onDetails, onReset }: RowActions & { cursor?: string }) {
  const { data, isLoading, isError } = useAdminUsers(cursor);

  if (isLoading) {
    return (
      <TableRow>
        <TableCell colSpan={6}>
          <Skeleton className="h-5 w-full" data-testid="user-row-skeleton" />
        </TableCell>
      </TableRow>
    );
  }

  if (isError) {
    return (
      <TableRow>
        <TableCell colSpan={6} className="text-muted-foreground">
          Failed to load users.
        </TableCell>
      </TableRow>
    );
  }

  if (!data) return null;

  if (cursor === undefined && data.items.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={6} className="text-muted-foreground">
          No users found.
        </TableCell>
      </TableRow>
    );
  }

  return (
    <>
      {data.items.map((u) => (
        <TableRow key={u.id}>
          <TableCell>{u.email}</TableCell>
          <TableCell>{formatDate(u.createdAt)}</TableCell>
          <TableCell>{u.lastActiveAt === null ? '—' : formatDate(u.lastActiveAt)}</TableCell>
          <TableCell>
            {/* Read-only verified signal (REQ-5.7) — neutral, no action; v1 gates nothing. */}
            {u.emailVerified ? (
              <Check
                role="img"
                aria-label={`${u.email} verified`}
                className="size-4 text-muted-foreground"
              />
            ) : (
              '—'
            )}
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <Switch
                checked={u.isAdmin}
                onCheckedChange={() => onToggle(u)}
                aria-label={`Toggle admin access for ${u.email}`}
                className="cursor-pointer"
              />
              {u.isAdmin && <Badge>Admin</Badge>}
            </div>
          </TableCell>
          <TableCell>
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer"
                onClick={() => onDetails(u)}
              >
                Details
              </Button>
              {/* Destructive, so it is styled as such and sits last — the
                  rightmost control in a row is the one a mis-aimed click is
                  least likely to land on. */}
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive cursor-pointer"
                onClick={() => onReset(u)}
              >
                Reset
              </Button>
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function UserDetailDialog({
  user,
  onClose,
}: {
  user: AdminUserListItem | null;
  onClose: () => void;
}) {
  const detail = useAdminUser(user?.id);

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user?.email}</DialogTitle>
          <DialogDescription>User detail</DialogDescription>
        </DialogHeader>
        {detail.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : detail.isError ? (
          <p className="text-sm text-destructive">Failed to load user detail.</p>
        ) : detail.data ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatDate(detail.data.createdAt)}</dd>
            <dt className="text-muted-foreground">Last seen</dt>
            <dd>
              {detail.data.lastActiveAt === null ? '—' : formatDate(detail.data.lastActiveAt)}
            </dd>
            <dt className="text-muted-foreground">Positions</dt>
            <dd>{detail.data.positionCount}</dd>
            {/* Platform-key turns only from plan-tiers on (REQ-8.3) — BYOK
                turns are deliberately uncounted. */}
            <dt className="text-muted-foreground">
              Platform-key advisor turns (current UTC month)
            </dt>
            <dd>{detail.data.advisorTurns}</dd>
            <dt className="text-muted-foreground">Input tokens</dt>
            <dd>{detail.data.usage.inputTokens}</dd>
            <dt className="text-muted-foreground">Output tokens</dt>
            <dd>{detail.data.usage.outputTokens}</dd>
            <dt className="text-muted-foreground">Billed credits</dt>
            <dd>{detail.data.usage.billedCredits}</dd>
            <dt className="text-muted-foreground">Wallet balance</dt>
            <dd>{formatMicroUsd(detail.data.walletBalance)}</dd>
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function UserTable() {
  const { user: currentUser } = useAuth();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pendingToggle, setPendingToggle] = useState<AdminUserListItem | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [detailUser, setDetailUser] = useState<AdminUserListItem | null>(null);
  const [resetUser, setResetUser] = useState<AdminUserListItem | null>(null);

  // Same query key as the last mounted page — shared cache, no extra fetch.
  const lastPage = useAdminUsers(cursors[cursors.length - 1]);
  const toggleAdmin = useToggleAdmin();

  const openConfirm = (user: AdminUserListItem) => {
    setToggleError(null);
    setPendingToggle(user);
  };

  const confirmToggle = () => {
    if (!pendingToggle) return;
    toggleAdmin.mutate(
      { userId: pendingToggle.id, isAdmin: !pendingToggle.isAdmin },
      {
        onSuccess: () => {
          setPendingToggle(null);
        },
        onError: (err) => {
          const message =
            getErrorCode(err) === 'LAST_ADMIN'
              ? 'Cannot remove the last admin'
              : 'Failed to update admin access. Try again.';
          setToggleError(message);
          toast.error(message);
        },
      },
    );
  };

  const isDemotion = pendingToggle?.isAdmin === true;
  const isSelfDemotion = isDemotion && pendingToggle?.id === currentUser?.id;

  return (
    <TooltipProvider>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>
              <Tooltip>
                <TooltipTrigger className="inline-flex cursor-pointer items-center gap-1">
                  Last seen
                  <Info className="size-3" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>{LAST_SEEN_CAVEAT}</TooltipContent>
              </Tooltip>
            </TableHead>
            <TableHead>Verified</TableHead>
            <TableHead>Admin</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cursors.map((cursor) => (
            <UserTableRows
              key={cursor ?? 'first'}
              cursor={cursor}
              onToggle={openConfirm}
              onDetails={setDetailUser}
              onReset={setResetUser}
            />
          ))}
        </TableBody>
      </Table>

      {lastPage.data?.nextCursor && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => setCursors((prev) => [...prev, lastPage.data.nextCursor as string])}
          >
            Load more
          </Button>
        </div>
      )}

      <FactoryResetDialog user={resetUser} onClose={() => setResetUser(null)} />

      <Dialog
        open={pendingToggle !== null}
        onOpenChange={(open) => {
          if (!open) setPendingToggle(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isDemotion ? 'Remove admin access' : 'Grant admin access'}</DialogTitle>
            <DialogDescription>
              {isSelfDemotion
                ? 'You are removing your own admin access. You will immediately lose access to this admin page.'
                : isDemotion
                  ? `Remove admin access from ${pendingToggle?.email}?`
                  : `Grant admin access to ${pendingToggle?.email}?`}
            </DialogDescription>
          </DialogHeader>
          {toggleError && (
            <p role="alert" className="text-sm text-destructive">
              {toggleError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => setPendingToggle(null)}
            >
              Cancel
            </Button>
            <Button
              variant={isDemotion ? 'destructive' : 'default'}
              className="cursor-pointer"
              disabled={toggleAdmin.isPending}
              onClick={confirmToggle}
            >
              {isDemotion ? 'Remove admin access' : 'Grant admin access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UserDetailDialog user={detailUser} onClose={() => setDetailUser(null)} />
    </TooltipProvider>
  );
}

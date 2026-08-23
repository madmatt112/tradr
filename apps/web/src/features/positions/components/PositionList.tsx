import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { PageHeader } from '@/components/layout/PageHeader';
import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { captureClientEvent } from '@/lib/telemetry/posthog';
import { cn } from '@/lib/utils';
import { useDrawerStore } from '@/stores/drawer.store';

import { usePositions } from '../hooks/usePositions';
import { decodeOptionContract } from '../utils/optionContract';
import { positionAgeDays } from '../utils/positionAge';
import { shouldNavigateFromRowClick } from '../utils/rowNavigation';

import { CreatePositionDialog } from './CreatePositionDialog';
import { PositionRowActions } from './PositionRowActions';
import { PositionSideChip, PositionStatusChip } from './PositionStatusChip';

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
] as const;

export function PositionList() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: accounts } = useAccounts();
  const { data: positions, isLoading } = usePositions(
    statusFilter === 'all' ? undefined : { status: statusFilter },
  );
  const inspectPosition = useDrawerStore((s) => s.inspectPosition);
  const inspectedId = useDrawerStore((s) => s.inspectedPosition?.id ?? null);
  // The browse/inspect two-state: while the drawer is open the wide columns
  // (Account, Entry, Exit, Fees, Age) yield so the table fits beside it — ONE
  // state change drives both the drawer and the columns, so the width settles
  // in a single reflow, and the drawer's own transition already honours
  // reduced motion.
  const drawerOpen = useDrawerStore((s) => s.isOpen);

  const hasAccounts = !!accounts?.length;

  // Fire a single deliberate product event on the dialog open transition (REQ-3.8,
  // design Component 9). No-op when PostHog is unconfigured. Routed through here so
  // it fires once per open, regardless of whether the open came from the button or
  // the dialog's own onOpenChange.
  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      captureClientEvent('position_create_dialog_opened');
    }
    setDialogOpen(open);
  };

  return (
    <>
      <PageHeader
        page="Positions"
        right={
          hasAccounts ? (
            // `data-tour` is the walkthrough's anchor for the log-a-position
            // step. Only on the enabled branch: a tour that reached this step has
            // an account, and highlighting a disabled button would be a dead end.
            <Button
              data-tour="position-new"
              className="cursor-pointer"
              onClick={() => handleDialogOpenChange(true)}
            >
              New Position
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button className="cursor-pointer" disabled>
                    New Position
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Create an account first</TooltipContent>
            </Tooltip>
          )
        }
      />

      <Tabs value={statusFilter} onValueChange={setStatusFilter} className="mb-4">
        <TabsList>
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="cursor-pointer">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !positions?.length ? (
        <div className="py-12 text-center text-muted-foreground">No positions found.</div>
      ) : (
        <Table className="text-sm">
          <TableHeader>
            <TableRow className="border-hairline">
              <TableHead>Symbol</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Status</TableHead>
              {!drawerOpen && <TableHead>Account</TableHead>}
              <TableHead className="text-right">Qty</TableHead>
              {!drawerOpen && <TableHead className="text-right">Entry</TableHead>}
              {!drawerOpen && <TableHead className="text-right">Exit</TableHead>}
              <TableHead className="text-right">P&L</TableHead>
              <TableHead className="text-right">R</TableHead>
              {!drawerOpen && <TableHead className="text-right">Fees</TableHead>}
              {!drawerOpen && <TableHead className="text-right">Age</TableHead>}
              <TableHead className="w-10 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((pos) => {
              const optionContract =
                pos.assetType === 'option' ? decodeOptionContract(pos.symbol) : null;
              const qty = pos.status === 'closed' ? pos.closedUnits : pos.openUnits;
              const age = positionAgeDays(pos.openedAt, pos.closedAt);
              const selected = pos.id === inspectedId;
              return (
                <TableRow
                  key={pos.id}
                  className={cn(
                    'h-[31px] cursor-pointer border-hairline',
                    // The selected row wears the same amber tick as the active
                    // nav item — one selection language everywhere.
                    selected &&
                      'bg-secondary shadow-[inset_2px_0_0_var(--color-primary)] hover:bg-secondary',
                  )}
                  data-state={selected ? 'selected' : undefined}
                  onClick={(e) => {
                    if (!shouldNavigateFromRowClick(e)) return;
                    inspectPosition(pos);
                  }}
                >
                  <TableCell className="py-0 font-medium">
                    {/* The symbol link stays the keyboard/deep-link path to the
                        full detail page; the row click is the drawer inspect. */}
                    <Link
                      to="/positions/$positionId"
                      params={{ positionId: pos.id }}
                      className="hover:underline"
                      title={pos.symbol}
                    >
                      {optionContract ? optionContract.underlying : pos.symbol}
                    </Link>
                    {optionContract && (
                      <span className="block text-xs leading-none text-muted-foreground">
                        {optionContract.compactLabel}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-0">
                    <PositionSideChip side={pos.side} />
                  </TableCell>
                  <TableCell className="py-0">
                    <PositionStatusChip status={pos.status} />
                  </TableCell>
                  {!drawerOpen && <TableCell className="py-0">{pos.accountName}</TableCell>}
                  <TableCell className="py-0 text-right">
                    <Numeric
                      value={qty === 0 && pos.status === 'draft' ? null : qty}
                      kind="integer"
                      direction="none"
                    />
                  </TableCell>
                  {!drawerOpen && (
                    <TableCell className="py-0 text-right">
                      <Numeric
                        value={pos.avgEntryPrice}
                        kind="money"
                        currency={pos.accountCurrency}
                        direction="none"
                      />
                    </TableCell>
                  )}
                  {!drawerOpen && (
                    <TableCell className="py-0 text-right">
                      <Numeric
                        value={pos.avgExitPrice}
                        kind="money"
                        currency={pos.accountCurrency}
                        direction="none"
                      />
                    </TableCell>
                  )}
                  <TableCell className="py-0 text-right" data-testid="position-pnl">
                    <Numeric
                      value={pos.netPnl}
                      kind="money"
                      currency={pos.accountCurrency}
                      direction="auto"
                    />
                  </TableCell>
                  <TableCell className="py-0 text-right">
                    <Numeric value={pos.actualRR} kind="decimal" direction="auto" />
                  </TableCell>
                  {!drawerOpen && (
                    <TableCell className="py-0 text-right">
                      <Numeric
                        value={pos.brokerageFees > 0 ? pos.brokerageFees : null}
                        kind="money"
                        currency={pos.accountCurrency}
                        direction="none"
                      />
                    </TableCell>
                  )}
                  {!drawerOpen && (
                    <TableCell className="py-0 text-right">
                      {age !== null ? (
                        <span className="font-mono text-xs text-muted-foreground">{age}d</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="py-0">
                    <PositionRowActions position={pos} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CreatePositionDialog open={dialogOpen} onOpenChange={handleDialogOpenChange} />
    </>
  );
}

import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { Numeric } from '@/components/Numeric';
import { Badge } from '@/components/ui/badge';
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
import { formatCurrency } from '@/lib/format';
import { captureClientEvent } from '@/lib/telemetry/posthog';

import { usePositions } from '../hooks/usePositions';
import { decodeOptionContract } from '../utils/optionContract';
import { shouldNavigateFromRowClick } from '../utils/rowNavigation';

import { CreatePositionDialog } from './CreatePositionDialog';
import { PositionRowActions } from './PositionRowActions';

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
] as const;

export function PositionList() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: accounts } = useAccounts();
  const { data: positions, isLoading } = usePositions(
    statusFilter === 'all' ? undefined : { status: statusFilter },
  );

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
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Positions</h1>
        {hasAccounts ? (
          <Button className="cursor-pointer" onClick={() => handleDialogOpenChange(true)}>
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
        )}
      </div>

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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Entry Price</TableHead>
              <TableHead className="text-right">Target Price</TableHead>
              <TableHead className="text-right">Exit Price</TableHead>
              <TableHead className="text-right">Target R/R</TableHead>
              <TableHead className="text-right">Actual R/R</TableHead>
              <TableHead className="text-right"># Open</TableHead>
              <TableHead className="text-right"># Closed</TableHead>
              <TableHead className="text-right">P&L</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((pos) => {
              const optionContract =
                pos.assetType === 'option' ? decodeOptionContract(pos.symbol) : null;
              return (
                <TableRow
                  key={pos.id}
                  className="cursor-pointer"
                  onClick={(e) => {
                    if (!shouldNavigateFromRowClick(e)) return;
                    navigate({ to: '/positions/$positionId', params: { positionId: pos.id } });
                  }}
                >
                  <TableCell>
                    <Link
                      to="/positions/$positionId"
                      params={{ positionId: pos.id }}
                      className="font-medium hover:underline"
                      title={pos.symbol}
                    >
                      {optionContract ? optionContract.underlying : pos.symbol}
                    </Link>
                    {optionContract && (
                      <span className="block text-xs text-muted-foreground">
                        {optionContract.compactLabel}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={pos.side === 'long' ? 'default' : 'secondary'}>
                      {pos.side}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{pos.status}</Badge>
                  </TableCell>
                  <TableCell>{pos.accountName}</TableCell>
                  <TableCell className="text-right">
                    <Numeric
                      value={pos.avgEntryPrice}
                      kind="money"
                      currency={pos.accountCurrency}
                      direction="none"
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Numeric
                      value={pos.targetPrice}
                      kind="money"
                      currency={pos.accountCurrency}
                      direction="none"
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Numeric
                      value={pos.avgExitPrice}
                      kind="money"
                      currency={pos.accountCurrency}
                      direction="none"
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Numeric value={pos.targetRR} kind="decimal" direction="none" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Numeric value={pos.actualRR} kind="decimal" direction="auto" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Numeric value={pos.openUnits} kind="integer" direction="none" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Numeric value={pos.closedUnits} kind="integer" direction="none" />
                  </TableCell>
                  <TableCell className="text-right" data-testid="position-pnl">
                    <Numeric
                      value={pos.netPnl}
                      kind="money"
                      currency={pos.accountCurrency}
                      direction="auto"
                    />
                    {pos.brokerageFees > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        Fees: {formatCurrency(pos.brokerageFees, pos.accountCurrency)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
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

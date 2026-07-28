import type { SuperficialLossFlag, WashSaleFlag } from '@tradr/shared/schemas/expense';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';

// Translated reason labels. Two values per the v1 closed enum on
// `WashSaleFlag.reason` (packages/shared/src/schemas/expense.ts).
const REASON_LABELS: Record<WashSaleFlag['reason'], string> = {
  repurchase_within_30_days: 'Repurchase within 30 days',
  held_open_in_30d_window: 'Held open in 30-day window',
};

interface WashSaleFlagsTableProps {
  flags: WashSaleFlag[] | SuperficialLossFlag[];
  kind: 'washSale' | 'superficialLoss';
  /** Display currency for the realised-loss column. Per-position currency is
   * not carried on the flag shape; the loss decimal is rendered in the
   * tax-summary display currency. Falls back to no currency code when null. */
  displayCurrency: string | null;
}

function truncateIds(ids: string[]): string {
  if (ids.length === 0) return '—';
  if (ids.length <= 2) return ids.join(', ');
  return `${ids.slice(0, 2).join(', ')} +${ids.length - 2} more`;
}

export function WashSaleFlagsTable({ flags, displayCurrency }: WashSaleFlagsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead>Underlying</TableHead>
          <TableHead>Side</TableHead>
          <TableHead>Opened</TableHead>
          <TableHead>Closed</TableHead>
          <TableHead className="text-right">Realised loss</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Counterparty position ids</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {flags.map((flag) => (
          <TableRow key={flag.positionId}>
            <TableCell className="font-medium">{flag.symbol}</TableCell>
            <TableCell>{flag.underlying ?? flag.symbol}</TableCell>
            <TableCell className="capitalize">{flag.side}</TableCell>
            <TableCell>{flag.openedAt}</TableCell>
            <TableCell>{flag.closedAt}</TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {displayCurrency
                ? formatCurrency(parseFloat(flag.realisedLoss), displayCurrency)
                : flag.realisedLoss}
            </TableCell>
            <TableCell>{REASON_LABELS[flag.reason]}</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {truncateIds(flag.counterpartyPositionIds)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

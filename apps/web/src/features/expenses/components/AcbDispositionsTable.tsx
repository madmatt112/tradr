import type { AcbDispositionRow } from '@tradr/shared/schemas/expense';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';

const UNPRICED_REASON_LABELS: Record<NonNullable<AcbDispositionRow['unpricedReason']>, string> = {
  missing_rate: 'Missing rate',
  pool_unpriced: 'Pool unpriced',
  insufficient_pool: 'Exceeds pool',
};

interface AcbDispositionsTableProps {
  rows: AcbDispositionRow[];
}

export function AcbDispositionsTable({ rows }: AcbDispositionsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead>Trade date</TableHead>
          <TableHead className="text-right">Quantity</TableHead>
          <TableHead className="text-right">Rate</TableHead>
          <TableHead className="text-right">Proceeds</TableHead>
          <TableHead className="text-right">Outlays</TableHead>
          <TableHead className="text-right">ACB</TableHead>
          <TableHead className="text-right">Gain</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.exitFillId}>
            <TableCell className="font-medium">{row.symbol}</TableCell>
            <TableCell>{row.tradeDate}</TableCell>
            <TableCell className="text-right">{row.quantity}</TableCell>
            <TableCell className="text-right whitespace-nowrap">{row.cadRate ?? '—'}</TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {row.proceeds !== null ? formatCurrency(parseFloat(row.proceeds), 'CAD') : '—'}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {row.outlays !== null ? formatCurrency(parseFloat(row.outlays), 'CAD') : '—'}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {row.acb !== null ? formatCurrency(parseFloat(row.acb), 'CAD') : '—'}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {row.gain !== null ? formatCurrency(parseFloat(row.gain), 'CAD') : '—'}
            </TableCell>
            <TableCell>
              {row.unpricedReason ? UNPRICED_REASON_LABELS[row.unpricedReason] : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

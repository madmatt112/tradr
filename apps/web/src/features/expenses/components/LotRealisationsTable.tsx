import type { LotRealisationRow, TaxJurisdiction } from '@tradr/shared/schemas/expense';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';

interface LotRealisationsTableProps {
  rows: LotRealisationRow[];
  jurisdiction: TaxJurisdiction;
}

export function LotRealisationsTable({ rows, jurisdiction }: LotRealisationsTableProps) {
  const showTerm = jurisdiction === 'US';

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead>Lot opened</TableHead>
          <TableHead>Realised</TableHead>
          <TableHead className="text-right">Quantity</TableHead>
          <TableHead className="text-right">Proceeds</TableHead>
          <TableHead className="text-right">Basis</TableHead>
          <TableHead className="text-right">Fees</TableHead>
          <TableHead className="text-right">Net</TableHead>
          {showTerm && <TableHead>Term</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.exitFillId}:${row.entryFillId}`}>
            <TableCell className="font-medium">{row.symbol}</TableCell>
            <TableCell>{row.lotOpenedAt}</TableCell>
            <TableCell>{row.realisedAt}</TableCell>
            <TableCell className="text-right">{row.quantity}</TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {formatCurrency(parseFloat(row.proceeds), row.currency)}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {formatCurrency(parseFloat(row.basis), row.currency)}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {formatCurrency(parseFloat(row.fees), row.currency)}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {formatCurrency(parseFloat(row.net), row.currency)}
            </TableCell>
            {showTerm && <TableCell className="capitalize">{row.term ?? '—'}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

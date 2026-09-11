import type { CsvPreviewResponse, ProposedPosition } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { decodeOptionContract } from '@/features/positions/utils/optionContract';
import { cn } from '@/lib/utils';

/**
 * The position label: for an option whose stored symbol decodes, the contract in
 * words (e.g. "AAPL 20 Mar 2026 $250 Call") with the exact stored compact symbol
 * beside it; otherwise the raw symbol as-is (REQ-5.1). Uses the same decoder the
 * read side uses (`decodeOptionContract`, `optionContract.ts`).
 */
function ContractLabel({ scope }: { scope: ProposedPosition['scope'] }) {
  const contract = scope.assetType === 'option' ? decodeOptionContract(scope.symbol) : null;
  if (!contract) {
    return <span className="font-medium">{scope.symbol}</span>;
  }
  return (
    <>
      <span className="font-medium">
        {contract.underlying} {contract.expiryLabel} {contract.strikeLabel} {contract.typeLabel}
      </span>
      <span className="text-xs text-muted-foreground font-mono">{scope.symbol}</span>
    </>
  );
}

interface ProposedPositionsProps {
  positions: ProposedPosition[];
  errors: CsvPreviewResponse['errors'];
  warnings: CsvPreviewResponse['warnings'];
  currencyCode: string;
}

/**
 * Proposed positions/fills with per-row error/warning highlighting in place
 * (REQ-12.3) and the per-position proposed P&L (REQ-12.4 / Task 1 `proposedPnl`).
 * Errors/warnings are keyed to a fill by `rowNumber` ↔ `sourceRow`, so a bad row
 * is highlighted on the exact fill it produced. P&L is only known for closing
 * positions; open positions show "—".
 */
export function ProposedPositions({
  positions,
  errors,
  warnings,
  currencyCode,
}: ProposedPositionsProps) {
  const errorRows = new Set(errors.map((e) => e.rowNumber).filter((n) => n > 0));
  const warningRows = new Set(
    warnings.map((w) => w.rowNumber).filter((n): n is number => typeof n === 'number' && n > 0),
  );

  if (positions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Proposed positions</CardTitle>
          <CardDescription>No importable positions were produced.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Proposed positions ({positions.length})</CardTitle>
        <CardDescription>
          Each block is one position and its fills, with proposed P&amp;L for closed positions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {positions.map((pos, pi) => (
          <div key={`${pos.scope.symbol}-${pi}`} className="space-y-2">
            <div className="flex items-center gap-2">
              <ContractLabel scope={pos.scope} />
              <Badge variant={pos.side === 'long' ? 'default' : 'secondary'}>{pos.side}</Badge>
              <Badge variant="outline">{pos.closes ? 'closes' : 'open'}</Badge>
              {pos.scope.assetType === 'option' && <Badge variant="outline">option</Badge>}
              <span className="ml-auto text-sm">
                P&amp;L:{' '}
                {pos.closes && pos.proposedPnl !== undefined ? (
                  <Numeric
                    value={pos.proposedPnl}
                    kind="money"
                    currency={currencyCode}
                    direction="auto"
                  />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Fees</TableHead>
                  <TableHead>Filled at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pos.fills.map((fill, fi) => {
                  const hasError = errorRows.has(fill.sourceRow);
                  const hasWarning = !hasError && warningRows.has(fill.sourceRow);
                  return (
                    <TableRow
                      key={`${fill.sourceRow}-${fi}`}
                      className={cn(hasError && 'bg-destructive/10', hasWarning && 'bg-warning/10')}
                    >
                      <TableCell>{fill.sourceRow}</TableCell>
                      <TableCell>{fill.type}</TableCell>
                      <TableCell className="text-right">{fill.quantity}</TableCell>
                      <TableCell className="text-right">{fill.price}</TableCell>
                      <TableCell className="text-right">{fill.fees}</TableCell>
                      <TableCell>{fill.filledAt}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

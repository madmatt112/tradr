import type { ProposedEvent, ProposedPosition } from '@tradr/shared';

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

interface ProposedEventsProps {
  events: ProposedEvent[];
  positions: ProposedPosition[];
}

function ContractLabel({ symbol }: { symbol: string }) {
  const contract = decodeOptionContract(symbol);
  if (!contract) {
    return <span className="font-medium">{symbol}</span>;
  }
  return (
    <>
      <span className="font-medium">
        {contract.underlying} {contract.expiryLabel} {contract.strikeLabel} {contract.typeLabel}
      </span>
      <span className="ml-2 text-xs text-muted-foreground font-mono">{symbol}</span>
    </>
  );
}

// A `segment` target resolves to the same-file position it will settle (no
// position id exists yet at preview time); an `open_leg` target names the
// existing position directly. Mirrors GroupProposal's `legRefs` ->
// `positions[ref].scope.symbol` pattern (ProposedPositions.tsx).
function targetLabel(target: ProposedEvent['target'], positions: ProposedPosition[]): string {
  if (target.kind === 'segment') {
    const ref = target.segmentRef;
    return (ref !== undefined ? positions[ref]?.scope.symbol : undefined) ?? '—';
  }
  return target.positionId ?? '—';
}

/**
 * Proposed lifecycle events (assignment/exercise) and the leg each will settle
 * against (design C12/TD10; AC 10.2).
 */
export function ProposedEvents({ events, positions }: ProposedEventsProps) {
  if (events.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Proposed lifecycle events ({events.length})</CardTitle>
        <CardDescription>
          Assignments and exercises this import will settle against a leg.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Contract</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Settled at</TableHead>
              <TableHead>Target</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event, i) => (
              <TableRow key={`${event.rowNumber}-${i}`}>
                <TableCell>{event.rowNumber}</TableCell>
                <TableCell>
                  <Badge variant="outline">{event.outcome}</Badge>
                </TableCell>
                <TableCell>
                  <ContractLabel symbol={event.symbol} />
                </TableCell>
                <TableCell className="text-right">{event.quantity}</TableCell>
                <TableCell>{event.settledAt}</TableCell>
                <TableCell className="font-mono text-xs">
                  {targetLabel(event.target, positions)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

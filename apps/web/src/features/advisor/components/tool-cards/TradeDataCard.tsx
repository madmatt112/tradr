// TradeDataCard — typed card for `trade_data_*` tool results (REQ-14.2).
//
// Trade-data ok-results carry compact projections: `{ count, positions }`,
// `{ count, accounts }`, or a P&L summary `{ granularity, currencies }`. We
// surface a count line when present, then fall through to the safe payload
// rendering so an unexpected shape never crashes. Error results delegate to
// GenericToolCard for non-alarming copy (REQ-14.4).

import type { ToolResultPart } from '@tradr/shared/schemas/advisor';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { GenericToolCard, safeStringify } from './GenericToolCard';

export interface TradeDataCardProps {
  toolName?: string;
  result: ToolResultPart;
}

function countOf(content: unknown): number | undefined {
  if (content && typeof content === 'object' && 'count' in content) {
    const c = (content as { count: unknown }).count;
    if (typeof c === 'number') return c;
  }
  return undefined;
}

export function TradeDataCard({ toolName, result }: TradeDataCardProps) {
  if (result.status === 'error') {
    return <GenericToolCard toolName={toolName} result={result} />;
  }

  const count = countOf(result.content);

  return (
    <Card data-testid="trade-data-card" className="gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">
          {count === undefined ? 'Your trade data' : `Your trade data — ${count} record(s)`}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap">
          {safeStringify(result.content)}
        </pre>
      </CardContent>
    </Card>
  );
}

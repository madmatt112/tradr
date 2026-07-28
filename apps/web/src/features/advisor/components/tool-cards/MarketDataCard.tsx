// MarketDataCard — typed card for `market_data_*` tool results (REQ-14.2).
//
// Market-data ok-results carry a `{ symbol, ... }` projection (stock quote,
// options flow, options chain). We surface the symbol and a compact summary
// line, then fall through to GenericToolCard's safe rendering for the payload
// detail so an unexpected shape never crashes. Error results delegate to
// GenericToolCard for the non-alarming copy (REQ-14.4).

import type { ToolResultPart } from '@tradr/shared/schemas/advisor';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { GenericToolCard, safeStringify } from './GenericToolCard';

export interface MarketDataCardProps {
  toolName?: string;
  result: ToolResultPart;
}

function symbolOf(content: unknown): string | undefined {
  if (content && typeof content === 'object' && 'symbol' in content) {
    const s = (content as { symbol: unknown }).symbol;
    if (typeof s === 'string') return s;
  }
  return undefined;
}

export function MarketDataCard({ toolName, result }: MarketDataCardProps) {
  if (result.status === 'error') {
    return <GenericToolCard toolName={toolName} result={result} />;
  }

  const symbol = symbolOf(result.content);

  return (
    <Card data-testid="market-data-card" className="gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">
          {symbol ? `Market data — ${symbol}` : 'Market data'}
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

// GenericToolCard — fallback renderer for any tool_result (REQ-14.2, 14.4).
//
// Renders a tool result whose tool name does not match a typed card, OR whose
// content shape is unknown. It NEVER crashes on an unexpected shape: the content
// is stringified defensively (JSON.stringify with a circular-safe fallback) and
// shown as plain text inside a <pre>. Error results render clear, non-alarming
// copy (REQ-14.4) instead of the raw payload.

import type { ToolResultPart } from '@tradr/shared/schemas/advisor';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface GenericToolCardProps {
  // The tool name resolved from the matching tool_call part, if known.
  toolName?: string;
  result: ToolResultPart;
}

// Friendly, non-alarming wording per stable error code (REQ-14.4). Unknown
// codes fall back to a generic line — never a stack trace or raw payload.
const ERROR_COPY: Record<string, string> = {
  TOOL_NOT_PERMITTED: "This tool isn't available for this request.",
  TOOL_INPUT_INVALID: "The request to this tool wasn't valid.",
  TOOL_TIMEOUT: 'This tool took too long to respond.',
  PLATFORM_RATE_LIMITED: 'Hit a usage limit — try again shortly.',
  TRADE_DATA_BUDGET_EXCEEDED: 'Reached the limit for trade-data this turn.',
  MARKET_DATA_KEY_INVALID: 'The market-data connection needs attention in Settings.',
  MARKET_DATA_RATE_LIMITED: 'Market data is busy right now — try again shortly.',
  MARKET_DATA_UNAVAILABLE: 'Market data is temporarily unavailable.',
  SYMBOL_NOT_FOUND: "Couldn't find data for that symbol.",
};

export function errorCopy(content: unknown): string {
  const code =
    content && typeof content === 'object' && 'code' in content
      ? String((content as { code: unknown }).code)
      : undefined;
  return (code && ERROR_COPY[code]) ?? "This tool couldn't complete its request.";
}

// Circular-safe stringify so an unexpected shape never throws (REQ-14.2).
export function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      value,
      (_key, val) => {
        if (val && typeof val === 'object') {
          if (seen.has(val as object)) return '[Circular]';
          seen.add(val as object);
        }
        return val;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

export function GenericToolCard({ toolName, result }: GenericToolCardProps) {
  const title = toolName ?? 'Tool result';

  return (
    <Card data-testid="generic-tool-card" className="gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        {result.status === 'error' ? (
          <p data-testid="tool-error" className="text-sm text-muted-foreground">
            {errorCopy(result.content)}
          </p>
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap">
            {safeStringify(result.content)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

import type { CsvPreviewResponse } from '@tradr/shared';

import { Card, CardContent } from '@/components/ui/card';

interface PreviewSummaryProps {
  summary: CsvPreviewResponse['summary'];
}

/**
 * Top-of-preview summary counts (REQ-12.3) plus the segmentation explanation
 * (REQ-4.6) so the user's mental model matches how rows were grouped into
 * positions. Imports are additive (REQ-12.6) — repeated here as standing copy.
 */
export function PreviewSummary({ summary }: PreviewSummaryProps) {
  const cells: Array<{ label: string; value: number; tone?: 'error' }> = [
    { label: 'Rows parsed', value: summary.rowsParsed },
    { label: 'Rows valid', value: summary.rowsValid },
    {
      label: 'Rows with errors',
      value: summary.rowsWithErrors,
      tone: summary.rowsWithErrors > 0 ? 'error' : undefined,
    },
    { label: 'Positions', value: summary.positions },
    { label: 'Fills', value: summary.fills },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 py-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {cells.map((c) => (
            <div key={c.label}>
              <div
                className={
                  c.tone === 'error'
                    ? 'text-2xl font-semibold text-destructive'
                    : 'text-2xl font-semibold'
                }
              >
                {c.value}
              </div>
              <div className="text-xs text-muted-foreground">{c.label}</div>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Fills are grouped into positions by symbol and direction. Each position runs from its
          first entry until it returns to flat; a new position starts after that. This import is
          additive — it adds these positions and fills to the target account.
        </p>
      </CardContent>
    </Card>
  );
}

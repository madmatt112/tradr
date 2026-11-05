import type { LocatedError, LocatedWarning } from '@tradr/shared';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface IssueListProps {
  errors: LocatedError[];
  warnings: LocatedWarning[];
}

function location(rowNumber?: number, csvColumn?: string, tradrField?: string): string {
  const parts: string[] = [];
  if (rowNumber && rowNumber > 0) parts.push(`Row ${rowNumber}`);
  if (csvColumn) parts.push(`column "${csvColumn}"`);
  if (tradrField) parts.push(`field ${tradrField}`);
  return parts.join(' · ');
}

/**
 * Located errors (blocking vs non-blocking) and warnings for the preview
 * (REQ-12.3). Blocking errors use the danger token and gate `committable`; a
 * `nonBlocking` error (a lifecycle event with no settlement target, design
 * C12) shows in its own warning-token card instead — its row will not import,
 * but the rest of the file still will. Warnings (duplicates, inferred
 * direction, missing fees column, rounding) use the warning token too and
 * never block confirm.
 */
export function IssueList({ errors, warnings }: IssueListProps) {
  const blockingErrors = errors.filter((e) => !e.nonBlocking);
  const nonBlockingErrors = errors.filter((e) => e.nonBlocking);

  if (blockingErrors.length === 0 && nonBlockingErrors.length === 0 && warnings.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {blockingErrors.length > 0 && (
        <Card className="border-destructive/50" data-testid="blocking-errors">
          <CardHeader>
            <CardTitle className="text-base text-destructive">
              Blocking errors ({blockingErrors.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {blockingErrors.map((e, i) => {
              const loc = location(e.rowNumber, e.csvColumn, e.tradrField);
              return (
                <div
                  key={`${e.code}-${i}`}
                  className="rounded-md bg-destructive/10 p-2 text-sm text-foreground"
                >
                  {loc && <span className="font-medium text-destructive">{loc}: </span>}
                  <span>{e.message}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {nonBlockingErrors.length > 0 && (
        <Card className="border-warning/50">
          <CardHeader>
            <CardTitle className="text-base text-warning">
              Rows that won&apos;t import ({nonBlockingErrors.length})
            </CardTitle>
            <CardDescription>
              Each row below will not import, but the rest of the file still will.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {nonBlockingErrors.map((e, i) => {
              const loc = location(e.rowNumber, e.csvColumn, e.tradrField);
              return (
                <div
                  key={`${e.code}-${i}`}
                  className="rounded-md bg-warning/10 p-2 text-sm text-foreground"
                >
                  {loc && <span className="font-medium text-warning">{loc}: </span>}
                  <span>{e.message}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {warnings.length > 0 && (
        <Card className="border-warning/50">
          <CardHeader>
            <CardTitle className="text-base text-warning">Warnings ({warnings.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {warnings.map((w, i) => {
              const loc = location(w.rowNumber, w.csvColumn);
              return (
                <div
                  key={`${w.kind}-${i}`}
                  className="rounded-md bg-warning/10 p-2 text-sm text-foreground"
                >
                  {loc && <span className="font-medium text-warning">{loc}: </span>}
                  <span>{w.message}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import type { LocatedError, LocatedWarning } from '@tradr/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
 * Located errors (blocking) and warnings (non-blocking) for the preview
 * (REQ-12.3). Errors use the danger token so the user sees exactly which
 * row/column/field is wrong; warnings (duplicates, inferred direction, missing
 * fees column, rounding) use the warning token and do not block confirm.
 */
export function IssueList({ errors, warnings }: IssueListProps) {
  if (errors.length === 0 && warnings.length === 0) return null;

  return (
    <div className="space-y-4">
      {errors.length > 0 && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-base text-destructive">
              Blocking errors ({errors.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {errors.map((e, i) => {
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

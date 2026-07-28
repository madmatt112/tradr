import type { ReactNode } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <Card className="mx-auto max-w-md">
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        {icon ? <div className="text-muted-foreground">{icon}</div> : null}
        <h3 className="text-lg font-semibold">{title}</h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}

interface TableEmptyStateProps {
  /** Number of columns in the table — the message cell spans all of them so the
   *  header's column geometry is preserved (R4.4). */
  colSpan: number;
  /** Empty/error message. */
  message: ReactNode;
  className?: string;
}

/**
 * EmptyState.Table — the table-shaped empty/error variant (R4.4). Renders a
 * single `<TableRow>` with one `colSpan`-ing `<TableCell>`, so it drops INTO a
 * table's `<TableBody>` without collapsing the column widths the `<TableHeader>`
 * establishes. Tabular surfaces use this instead of the centered-card
 * `EmptyState`, which keeps its whole-list role.
 */
function TableEmptyState({ colSpan, message, className }: TableEmptyStateProps) {
  return (
    <TableRow data-testid="table-empty-state">
      <TableCell
        colSpan={colSpan}
        className={cn('py-8 text-center text-sm text-muted-foreground', className)}
      >
        {message}
      </TableCell>
    </TableRow>
  );
}

EmptyState.Table = TableEmptyState;

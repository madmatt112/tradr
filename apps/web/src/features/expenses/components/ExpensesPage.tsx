import { Pencil, Receipt, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
} from '@tradr/shared/constants/expense-categories';
import type { Expense } from '@tradr/shared/schemas/expense';

import { EmptyState } from '@/components/EmptyState';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ExpenseFormDialog } from '@/features/expenses/components/ExpenseFormDialog';
import { useDeleteExpense, useExpenses } from '@/features/expenses/hooks/useExpenses';
import { formatCurrency } from '@/lib/format';

const ALL_YEARS = 'all';
const DEFAULT_PAGE_SIZE = 100;

// Req 5.1 specifies the range start as the earliest of MIN(expenses.occurredAt)
// and MIN(positions.closedAt). The list endpoint does not expose either min, so
// this is a partial implementation: a UI floor of current year + 5 prior years,
// extended downward by the earliest occurredAt actually present in the loaded
// page. A fully data-driven floor (querying min across both expenses and
// positions) is deferred to a backend change.
function buildYearOptions(currentYear: number, earliestExpenseYear: number | null): number[] {
  const floor = Math.min(currentYear - 5, earliestExpenseYear ?? currentYear);
  const years: number[] = [];
  for (let y = currentYear; y >= floor; y -= 1) {
    years.push(y);
  }
  return years;
}

function categoryLabel(category: ExpenseCategory): string {
  return EXPENSE_CATEGORY_LABELS[category];
}

function notesPreview(notes: string | null): string {
  if (!notes) return '';
  const trimmed = notes.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 60)}...`;
}

export function ExpensesPage() {
  const currentYear = new Date().getUTCFullYear();

  const [selectedYear, setSelectedYear] = useState<string>(String(currentYear));
  const [page, setPage] = useState(0);
  const [dialogState, setDialogState] = useState<
    { mode: 'create' } | { mode: 'edit'; expense: Expense } | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);

  const year = selectedYear === ALL_YEARS ? undefined : Number(selectedYear);

  const { data, isLoading, isError } = useExpenses({
    year,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const deleteExpense = useDeleteExpense();

  const expenses = data?.expenses ?? [];
  const filterTotals = data?.filterTotals;

  const earliestExpenseYear = useMemo<number | null>(() => {
    if (expenses.length === 0) return null;
    let min = Number.POSITIVE_INFINITY;
    for (const row of expenses) {
      const y = parseInt(row.occurredAt.slice(0, 4), 10);
      if (Number.isFinite(y) && y < min) min = y;
    }
    return Number.isFinite(min) ? min : null;
  }, [expenses]);

  const yearOptions = useMemo(
    () => buildYearOptions(currentYear, earliestExpenseYear),
    [currentYear, earliestExpenseYear],
  );

  const handleYearChange = (val: string) => {
    setSelectedYear(val);
    setPage(0);
  };

  const onConfirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteExpense.mutateAsync({ expenseId: target.id });
      toast.success('Expense deleted');
    } catch (err) {
      const message =
        typeof err === 'object' && err !== null && 'error' in err
          ? ((err as { error?: { message?: string } }).error?.message ?? 'Failed to delete expense')
          : 'Failed to delete expense';
      toast.error(message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Expenses</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track deductible expenses for your tax summary.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="expense-year" className="text-xs text-muted-foreground">
              Year
            </label>
            <Select value={selectedYear} onValueChange={handleYearChange}>
              <SelectTrigger id="expense-year" className="w-36 cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_YEARS}>All years</SelectItem>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            className="cursor-pointer"
            onClick={() => setDialogState({ mode: 'create' })}
          >
            Add expense
          </Button>
        </div>
      </div>

      {filterTotals && filterTotals.perCurrency.length > 0 && (
        <div className="rounded-md border p-4">
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Totals</h2>
          <div className="flex flex-wrap gap-4">
            {filterTotals.perCurrency.map((row) => (
              <div key={row.currency} className="text-sm">
                <span className="font-medium">
                  {formatCurrency(parseFloat(row.total), row.currency)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <div className="py-8 text-center text-sm text-destructive">
          Failed to load expenses. Please try again.
        </div>
      ) : expenses.length === 0 ? (
        <EmptyState
          icon={<Receipt className="h-10 w-10" />}
          title="No expenses recorded yet"
          description="Track data subscriptions, platform fees, education, and other trading costs here."
          action={
            <Button
              type="button"
              className="cursor-pointer"
              onClick={() => setDialogState({ mode: 'create' })}
            >
              Add expense
            </Button>
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">{row.occurredAt}</TableCell>
                  <TableCell>{categoryLabel(row.category)}</TableCell>
                  <TableCell className="font-medium">{row.description}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {formatCurrency(parseFloat(row.amount), row.currency)}
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    title={row.notes ?? undefined}
                  >
                    {notesPreview(row.notes)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => setDialogState({ mode: 'edit', expense: row })}
                        aria-label="Edit expense"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="cursor-pointer text-destructive"
                        onClick={() => setDeleteTarget(row)}
                        aria-label="Delete expense"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <div>
              Showing {expenses.length} of {filterTotals?.totalRowCount ?? expenses.length} expenses
            </div>
            {(page > 0 || (data?.hasMore ?? false)) && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  disabled={!(data?.hasMore ?? false)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      <ExpenseFormDialog
        mode={dialogState?.mode ?? 'create'}
        open={dialogState !== null}
        onOpenChange={(open) => {
          if (!open) setDialogState(null);
        }}
        initialExpense={dialogState?.mode === 'edit' ? dialogState.expense : null}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete expense</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && (
                <>
                  Delete &quot;{deleteTarget.description}&quot; (
                  {formatCurrency(parseFloat(deleteTarget.amount), deleteTarget.currency)}) from{' '}
                  {deleteTarget.occurredAt}? This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction className="cursor-pointer" onClick={onConfirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

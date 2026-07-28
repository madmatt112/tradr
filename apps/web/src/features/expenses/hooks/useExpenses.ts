import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type CreateExpenseInput,
  type Expense,
  type ExpenseListResponse,
  type UpdateExpenseInput,
  ExpenseListResponseSchema,
  ExpenseSchema,
} from '@tradr/shared/schemas/expense';

import { api } from '@/lib/api';

interface UseExpensesParams {
  year?: number;
  page: number;
  pageSize: number;
}

function buildExpensesPath({ year, page, pageSize }: UseExpensesParams): string {
  const params = new URLSearchParams();
  if (year !== undefined) params.set('year', String(year));
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return `/expenses?${params.toString()}`;
}

export function useExpenses({ year, page, pageSize }: UseExpensesParams) {
  return useQuery<ExpenseListResponse>({
    queryKey: ['expenses', { year, page, pageSize }],
    queryFn: async () => {
      const raw = await api.get<unknown>(buildExpensesPath({ year, page, pageSize }));
      return ExpenseListResponseSchema.parse(raw);
    },
  });
}

// Per Task 22 / design §Component 8 ("Invalidation rules"):
// Expense writes invalidate the `['expenses']` prefix (covers the LIST) AND
// the `['expenses', 'tax-summary']` prefix (tracked-expenses changes affect
// it). They do NOT invalidate `['expenses', 'fee-rollup']` — recorded fill
// fees are independent of manual expenses.
async function invalidateAfterExpenseWrite(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['expenses'] });
  await queryClient.invalidateQueries({ queryKey: ['expenses', 'tax-summary'] });
}

export function useCreateExpense() {
  const queryClient = useQueryClient();
  return useMutation<Expense, unknown, CreateExpenseInput>({
    mutationFn: async (input) => {
      const raw = await api.post<unknown>('/expenses', input);
      return ExpenseSchema.parse(raw);
    },
    onSuccess: async () => {
      await invalidateAfterExpenseWrite(queryClient);
    },
  });
}

export function useUpdateExpense() {
  const queryClient = useQueryClient();
  return useMutation<Expense, unknown, { expenseId: string; patch: UpdateExpenseInput }>({
    mutationFn: async ({ expenseId, patch }) => {
      const raw = await api.patch<unknown>(`/expenses/${expenseId}`, patch);
      return ExpenseSchema.parse(raw);
    },
    onSuccess: async () => {
      await invalidateAfterExpenseWrite(queryClient);
    },
  });
}

export function useDeleteExpense() {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, { expenseId: string }>({
    mutationFn: async ({ expenseId }) => {
      await api.delete<void>(`/expenses/${expenseId}`);
    },
    onSuccess: async () => {
      await invalidateAfterExpenseWrite(queryClient);
    },
  });
}

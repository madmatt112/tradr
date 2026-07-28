import { createFileRoute } from '@tanstack/react-router';

import { AccountingSubNav } from '@/features/expenses/components/AccountingSubNav';
import { ExpensesPage } from '@/features/expenses/components/ExpensesPage';

export const Route = createFileRoute('/_auth/accounting/expenses')({
  component: () => (
    <>
      <AccountingSubNav activeTab="expenses" />
      <ExpensesPage />
    </>
  ),
});

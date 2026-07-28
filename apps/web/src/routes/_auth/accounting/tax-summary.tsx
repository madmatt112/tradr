import { createFileRoute } from '@tanstack/react-router';

import { AccountingSubNav } from '@/features/expenses/components/AccountingSubNav';
import { TaxSummaryPage } from '@/features/expenses/components/TaxSummaryPage';

export const Route = createFileRoute('/_auth/accounting/tax-summary')({
  component: () => (
    <>
      <AccountingSubNav activeTab="tax-summary" />
      <TaxSummaryPage />
    </>
  ),
});

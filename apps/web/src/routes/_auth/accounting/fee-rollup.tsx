import { createFileRoute } from '@tanstack/react-router';

import { AccountingSubNav } from '@/features/expenses/components/AccountingSubNav';
import { FeeRollupPage } from '@/features/expenses/components/FeeRollupPage';

export const Route = createFileRoute('/_auth/accounting/fee-rollup')({
  component: () => (
    <>
      <AccountingSubNav activeTab="fee-rollup" />
      <FeeRollupPage />
    </>
  ),
});

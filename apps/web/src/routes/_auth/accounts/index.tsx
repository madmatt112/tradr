import { createFileRoute } from '@tanstack/react-router';

import { AccountList } from '@/features/accounts/components/AccountList';

export const Route = createFileRoute('/_auth/accounts/')({
  component: AccountList,
});

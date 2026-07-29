import type { FeeSchedule } from '@tradr/shared';

import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { useBrokerages } from '@/features/brokerages/hooks/useBrokerages';

/**
 * The fee schedule that applies to a position's account, or null when there is
 * none — the account has no brokerage, or the two cached queries have not
 * resolved yet.
 *
 * Callers treat null as "fees are not brokerage-calculatable" and fall back to
 * a manually editable fee field. Both queries are already warm elsewhere in the
 * app (the accounts list, the brokerages page), so this adds no fetch in
 * practice.
 */
export function useAccountFeeSchedule(accountId: string | undefined): FeeSchedule | null {
  const { data: accounts } = useAccounts();
  const { data: brokerages } = useBrokerages();

  if (!accountId) return null;
  const account = accounts?.find((a) => a.id === accountId);
  if (!account?.brokerageId) return null;
  return brokerages?.find((b) => b.id === account.brokerageId)?.feeSchedule ?? null;
}

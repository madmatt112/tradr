import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { isAccountWritable } from '@/features/billing/tier-usage';
import { useTierState } from '@/features/billing/useTierState';

interface AccountPickerProps {
  value: string | null;
  onChange: (accountId: string) => void;
}

/**
 * Step 1 of the import flow (REQ-12.1): pick the target account. The import is
 * additive — imported positions/fills land in this account.
 *
 * Non-writable accounts (plan-tiers D18: over the account cap on an enforced
 * free tier, id ≠ the designated writable account) are disabled + badged
 * instead of inviting a commit-time 403. Self-host/Pro/admin see no change.
 */
export function AccountPicker({ value, onChange }: AccountPickerProps) {
  const { data: accounts, isLoading, isError } = useAccounts();
  const { data: tierState } = useTierState();

  return (
    <div className="space-y-2">
      <Label htmlFor="import-account">Target account</Label>
      {isLoading && <p className="text-sm text-muted-foreground">Loading accounts…</p>}
      {isError && <p className="text-sm text-destructive">Could not load accounts. Try again.</p>}
      {!isLoading && !isError && accounts && accounts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Create an account first — imported trades need a target account.
        </p>
      )}
      {!isLoading && !isError && accounts && accounts.length > 0 && (
        <Select value={value ?? undefined} onValueChange={onChange}>
          <SelectTrigger id="import-account" className="w-full">
            <SelectValue placeholder="Select an account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => {
              const writable = isAccountWritable(tierState, account.id);
              return (
                <SelectItem key={account.id} value={account.id} disabled={!writable}>
                  {account.name} ({account.currency}){writable ? '' : ' — read-only on your plan'}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

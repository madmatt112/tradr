import { useState } from 'react';

import type { RuleWeight, TradingRule, TradingRuleInput } from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { useTags } from '@/features/tags/hooks/useTags';

import {
  useDeleteTradingRule,
  useTradingRules,
  useUpdateTradingRule,
} from '../hooks/useTradingRules';

import { DeleteRuleDialog } from './DeleteRuleDialog';
import { RuleDialog } from './RuleDialog';

const WEIGHT_LABELS: Record<RuleWeight, string> = {
  critical: 'Critical',
  important: 'Important',
  nice_to_have: 'Nice to have',
};

const WEIGHT_BADGE: Record<RuleWeight, 'destructive' | 'default' | 'secondary'> = {
  critical: 'destructive',
  important: 'default',
  nice_to_have: 'secondary',
};

// The switch sends the whole rule back as a full replacement (edits are full
// replacements, D2): only `enabled` differs.
function toInput(rule: TradingRule, enabled: boolean): TradingRuleInput {
  return {
    definition: rule.definition,
    weight: rule.weight,
    enabled,
    accountId: rule.accountId,
    tagId: rule.tagId,
  };
}

/**
 * The Settings **Rules** tab (design C9; REQ-1.7/1.8). The one place to see,
 * create, edit, enable, disable and delete rules. It reads the rules list plus
 * the accounts and tags lists (to name each rule's scope), toggles `enabled`
 * through the update mutation, and drives create/edit through `RuleDialog` and
 * delete through `DeleteRuleDialog`. It never computes an outcome or a score —
 * the generated `description` comes from the API (REQ-6.4).
 */
export function RulesSettings() {
  const { data: rules, isLoading, isError } = useTradingRules();
  const { data: accounts } = useAccounts();
  const { data: tags } = useTags();
  const updateRule = useUpdateTradingRule();
  const deleteRule = useDeleteTradingRule();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editRule, setEditRule] = useState<TradingRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TradingRule | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-3" data-slot="rules-settings">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (isError || !rules) {
    return (
      <div className="py-8 text-center text-sm text-destructive" data-slot="rules-settings">
        Failed to load rules. Please try again.
      </div>
    );
  }

  const openCreate = () => {
    setEditRule(null);
    setDialogOpen(true);
  };

  const newRuleButton = (
    <Button className="cursor-pointer" onClick={openCreate}>
      New rule
    </Button>
  );

  const accountName = (id: string) => accounts?.find((a) => a.id === id)?.name ?? 'account';
  const tagName = (id: string) => tags?.find((t) => t.id === id)?.name ?? 'tag';

  return (
    <div className="space-y-6" data-slot="rules-settings">
      {rules.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-2">{newRuleButton}</div>
          <ul className="divide-y divide-hairline rounded-md border">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 px-3 py-2">
                <Switch
                  checked={rule.enabled}
                  disabled={updateRule.isPending}
                  aria-label={`${rule.enabled ? 'Disable' : 'Enable'} rule`}
                  onCheckedChange={(checked) =>
                    updateRule.mutate({ id: rule.id, data: toInput(rule, checked) })
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{rule.description}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant={WEIGHT_BADGE[rule.weight]}>{WEIGHT_LABELS[rule.weight]}</Badge>
                    {rule.accountId && (
                      <Badge variant="outline">{accountName(rule.accountId)}</Badge>
                    )}
                    {rule.tagId && <Badge variant="outline">{tagName(rule.tagId)}</Badge>}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto cursor-pointer"
                      aria-label={`Actions for ${rule.description}`}
                    >
                      ⋯
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => {
                        setEditRule(rule);
                        setDialogOpen(true);
                      }}
                    >
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer text-destructive"
                      onClick={() => setDeleteTarget(rule)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <EmptyState
          title="No rules yet"
          description="Rules are scored and never block a trade — they check how you traded against how you meant to."
          action={newRuleButton}
        />
      )}

      <RuleDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditRule(null);
        }}
        rule={editRule}
      />

      {deleteTarget && (
        <DeleteRuleDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          rule={deleteTarget}
          onConfirm={() => {
            deleteRule.mutate(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}

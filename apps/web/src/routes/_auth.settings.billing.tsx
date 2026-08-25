import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { BillingPanel } from '@/features/billing/BillingPanel';
import { PlanCard } from '@/features/billing/PlanCard';
import { UsageHistory } from '@/features/billing/UsageHistory';
import { useBillingConfig } from '@/features/billing/useWalletBalance';
import { useAdvisorEnabled } from '@/hooks/useRegistrationEnabled';

// Stripe Checkout returns to `?subscription=confirming` (REQ-2.6); the cancel
// return is the bare tab. Total validation: the router JSON-parses search
// values (`?subscription=true` arrives as a boolean), so anything other than
// the literal 'confirming' degrades to undefined instead of breaking the tab.
const BillingSearchSchema = z.object({
  subscription: z.literal('confirming').optional().catch(undefined),
});

function SettingsBilling() {
  const { subscription } = Route.useSearch();
  const { data: config, isLoading } = useBillingConfig();
  // Credits fund platform (non-BYOK) advisor usage — with the advisor
  // withdrawn by default (useRegistrationEnabled.useAdvisorEnabled), there is
  // nothing to buy or spend them on, so the whole purchase surface stays
  // hidden alongside the advisor itself.
  const advisorEnabled = useAdvisorEnabled();

  return (
    <div className="space-y-8" data-slot="settings-billing">
      <div>
        <h2 className="text-lg font-medium">Billing</h2>
        <p className="text-sm text-muted-foreground">
          {advisorEnabled
            ? 'View your credit balance, buy credits, and review usage.'
            : 'Manage your subscription.'}
        </p>
      </div>

      {/* Plan card (REQ-11.1–11.3): self-fetching; renders iff gating is on or
          a subscription row exists, so on a true self-host it contributes
          nothing and the tab below stays byte-identical (REQ-11.7). The
          hide-everything-behind-`enabled` posture applies to the PURCHASE
          surfaces below only. */}
      <PlanCard confirming={subscription === 'confirming'} />

      {advisorEnabled &&
        (isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : config?.enabled ? (
          <>
            <BillingPanel packs={config.packs} />
            <UsageHistory />
          </>
        ) : (
          // Graceful absence (REQ-7.4): Stripe is not configured on this instance,
          // so there is nothing to purchase. The rest of settings is unaffected.
          <p className="text-sm text-muted-foreground" data-testid="billing-disabled">
            Billing is not enabled on this instance.
          </p>
        ))}
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/billing')({
  validateSearch: BillingSearchSchema,
  component: SettingsBilling,
});

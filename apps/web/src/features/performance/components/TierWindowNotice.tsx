// TierWindowNotice — the non-blocking L3 lookback-clamp disclosure (plan-tiers
// D13/REQ-7.3): rendered whenever a performance response carries `tierWindow`
// (server-set only on an enforced free tier, so nothing renders when gating is
// off). Purely informational — presets stay selectable and the clamped data
// renders beneath it; the fully-pre-boundary case shows the deliberate empty
// state with this same notice.

import type { PerformanceResponse } from '@tradr/shared';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { UpgradeLink } from '@/features/billing/UpgradeLink';
import { useTierState } from '@/features/billing/useTierState';
import { cn } from '@/lib/utils';

export interface TierWindowNoticeProps {
  tierWindow: NonNullable<PerformanceResponse['tierWindow']>;
  /** D17 funnel surface identifier for the upgrade CTA. */
  surface: string;
  className?: string;
}

export function TierWindowNotice({ tierWindow, surface, className }: TierWindowNoticeProps) {
  // Upgrade remedy only when the Pro subscription is actually purchasable
  // (REQ-11.5 posture — same gate as the sibling surfaces): a gated
  // Stripe-less instance keeps the informational clamp text, no dead-end link.
  const { data: tierState } = useTierState();

  return (
    <Alert
      data-testid="tier-window-notice"
      aria-live="polite"
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <AlertTitle>Limited analytics window</AlertTitle>
        <AlertDescription>
          {tierState?.purchasable
            ? `Showing the last ${tierWindow.lookbackMonths} months — upgrade for all-time analytics.`
            : `Showing the last ${tierWindow.lookbackMonths} months of analytics.`}
        </AlertDescription>
      </div>
      {tierState?.purchasable && (
        <UpgradeLink surface={surface} label="Upgrade" className="shrink-0" />
      )}
    </Alert>
  );
}

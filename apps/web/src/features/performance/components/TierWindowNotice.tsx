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
  /**
   * Single-line form for a fixed-height container. The boxed Alert costs 66px
   * plus the 12px stack gap, which no legal dashboard row span can absorb on
   * top of a widget's own content — see StatsSummaryWidget.height.test.tsx.
   * Same disclosure, same CTA, one line.
   */
  compact?: boolean;
  className?: string;
}

export function TierWindowNotice({
  tierWindow,
  surface,
  compact = false,
  className,
}: TierWindowNoticeProps) {
  // Upgrade remedy only when the Pro subscription is actually purchasable
  // (REQ-11.5 posture — same gate as the sibling surfaces): a gated
  // Stripe-less instance keeps the informational clamp text, no dead-end link.
  const { data: tierState } = useTierState();

  const text = tierState?.purchasable
    ? `Showing the last ${tierWindow.lookbackMonths} months — upgrade for all-time analytics.`
    : `Showing the last ${tierWindow.lookbackMonths} months of analytics.`;

  if (compact) {
    return (
      <div
        data-testid="tier-window-notice"
        role="status"
        aria-live="polite"
        className={cn(
          'flex items-center justify-between gap-3 text-xs text-muted-foreground',
          className,
        )}
      >
        <span className="truncate">{text}</span>
        {tierState?.purchasable && (
          <UpgradeLink surface={surface} label="Upgrade" className="h-6 shrink-0 px-2 text-xs" />
        )}
      </div>
    );
  }

  return (
    <Alert
      data-testid="tier-window-notice"
      aria-live="polite"
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <AlertTitle>Limited analytics window</AlertTitle>
        <AlertDescription>{text}</AlertDescription>
      </div>
      {tierState?.purchasable && (
        <UpgradeLink surface={surface} label="Upgrade" className="shrink-0" />
      )}
    </Alert>
  );
}

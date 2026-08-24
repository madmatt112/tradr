// PlanCard — current plan state, upgrade CTA, Portal link, and the
// post-Checkout confirming poll (design §Component 11, D16/D17;
// REQ-11.1–11.3, 11.6–11.7, REQ-2.6, REQ-4.4, REQ-13.1).
//
// Render condition (pinned): the card renders iff `gatingEnabled ||
// subscription !== null`. The four config states map as:
//   1. gating on + purchasable        → full card + upgrade CTA / Portal link
//   2. gating on + Stripe unconfigured → card from the mirror; purchase/Portal
//      affordances absent; "billing temporarily unavailable" when a
//      subscription row exists (REQ-11.1)
//   3. gating off + subscription row  → the REQ-11.7 carve-out: plan state +
//      Portal link only (a live recurring charge is never hidden, REQ-4.4)
//   4. gating off + no subscription   → nothing — the billing tab renders
//      byte-identical today's output (REQ-11.7)

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { TierLimits, TierState } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdvisorEnabled } from '@/hooks/useRegistrationEnabled';
import { formatCurrency } from '@/lib/format';
import { captureClientEvent } from '@/lib/telemetry/posthog';
import { cn } from '@/lib/utils';

import { useOpenPortal, useSubscribe } from './useSubscription';
import { useTierState } from './useTierState';

// Confirming poll (REQ-2.6): refetch the tier every 2 s until it reads `pro`,
// capped at 60 s. After the cap the banner degrades to a PERSISTENT non-error
// "still confirming" state — never a revert to Free + upgrade CTA, even under
// a misconfigured webhook endpoint. A transient error/429 during the poll is
// "still confirming", never a failure state (Component 6).
const POLL_INTERVAL_MS = 2_000;
const POLL_CAP_MS = 60_000;

const LEVERS: Array<{ key: keyof TierLimits; label: string }> = [
  { key: 'accounts', label: 'Connected accounts' },
  { key: 'positions', label: 'Positions' },
  { key: 'lookbackMonths', label: 'Analytics lookback' },
  { key: 'platformTurns', label: 'Advisor turns / month' },
  { key: 'images', label: 'Advisor image uploads / month' },
  { key: 'csvImports', label: 'CSV imports (lifetime)' },
];

// The levers that only mean something while the advisor is offered. On an
// instance that has withdrawn it (DISABLE_ADVISOR) they come off the upgrade
// summary and the usage bars rather than advertising a quota nobody can spend.
const ADVISOR_LEVERS: ReadonlySet<keyof TierLimits> = new Set(['platformTurns', 'images']);

function leverValue(key: keyof TierLimits, value: number | null): string {
  if (value === null) return 'Unlimited';
  if (key === 'lookbackMonths') return `${value} months`;
  return String(value);
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

interface UsageBar {
  key: keyof TierLimits;
  label: string;
  used: number;
  cap: number;
}

// The ≥80%-consumption disclosure bars (REQ-11.6 working default), measured
// against the CURRENT tier's caps; `null` caps (unlimited) never bar.
function usageBars(state: TierState): UsageBar[] {
  const { usage } = state;
  if (!usage) return [];
  const caps = state.limits[state.tier];
  const entries: Array<{ key: keyof TierLimits; label: string; used: number }> = [
    { key: 'accounts', label: 'Connected accounts', used: usage.accounts.used },
    { key: 'positions', label: 'Positions', used: usage.positions.used },
    {
      key: 'platformTurns',
      label: 'Advisor turns this month',
      used: usage.platformTurns.allowanceUsed,
    },
    { key: 'images', label: 'Image uploads this month', used: usage.images.used },
    { key: 'csvImports', label: 'CSV imports', used: usage.csvImports.used },
  ];
  const bars: UsageBar[] = [];
  for (const entry of entries) {
    const cap = caps[entry.key];
    if (cap === null || cap <= 0) continue;
    if (entry.used / cap >= 0.8) bars.push({ ...entry, cap });
  }
  return bars;
}

export interface PlanCardProps {
  /** True when the route mounted with `?subscription=confirming` (post-Checkout). */
  confirming?: boolean;
  /** Test seams ONLY (the pinned short-real-interval timer discipline) — production callers omit them. */
  pollIntervalMs?: number;
  pollCapMs?: number;
}

export function PlanCard({
  confirming = false,
  pollIntervalMs = POLL_INTERVAL_MS,
  pollCapMs = POLL_CAP_MS,
}: PlanCardProps) {
  // 'polling' → refetching every pollIntervalMs; 'capped' → the persistent
  // non-error still-confirming state; 'idle' → the normal card.
  const advisorEnabled = useAdvisorEnabled();
  const [phase, setPhase] = useState<'idle' | 'polling' | 'capped'>(
    confirming ? 'polling' : 'idle',
  );

  const tierQuery = useTierState({
    refetchInterval: phase === 'polling' ? pollIntervalMs : false,
  });
  const subscribe = useSubscribe();
  const portal = useOpenPortal();

  const state = tierQuery.data;
  const tier = state?.tier;

  // Cap the poll: after pollCapMs without a pro reading, stop refetching and
  // degrade to the persistent state (never back to Free + upgrade CTA).
  useEffect(() => {
    if (phase !== 'polling') return;
    const timer = setTimeout(() => setPhase('capped'), pollCapMs);
    return () => clearTimeout(timer);
  }, [phase, pollCapMs]);

  // Resolve the confirming state the moment the tier reads pro — including
  // after the cap (a late webhook still lands on a mount/focus refetch).
  useEffect(() => {
    if (phase !== 'idle' && tier === 'pro') setPhase('idle');
  }, [phase, tier]);

  // While confirming (in-poll or capped) render ONLY the banner: a transient
  // refetch error is "still confirming", never a failure state (REQ-2.6).
  if (phase !== 'idle') {
    return (
      <Card data-testid="subscription-confirming">
        <CardHeader>
          <CardTitle>Confirming your subscription…</CardTitle>
          <CardDescription>
            {phase === 'capped'
              ? 'Still confirming — this can take a minute; check back or contact support if it persists.'
              : 'This usually takes a few seconds.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!state) return null;
  if (!state.gatingEnabled && state.subscription === null) return null;

  const { subscription } = state;
  const showUpgrade = state.tier === 'free' && state.gatingEnabled && state.purchasable;
  const levers = advisorEnabled ? LEVERS : LEVERS.filter((l) => !ADVISOR_LEVERS.has(l.key));
  const bars = usageBars(state).filter((b) => advisorEnabled || !ADVISOR_LEVERS.has(b.key));

  const onUpgrade = () => {
    captureClientEvent('upgrade_cta_clicked', { surface: 'plan-card' }); // D17
    subscribe.mutate(undefined, {
      onError: () => toast.error("Couldn't start checkout. Try again."),
    });
  };

  const onManage = () => {
    portal.mutate(undefined, {
      onError: () => toast.error("Couldn't open the billing portal. Try again."),
    });
  };

  return (
    <Card data-testid="plan-card">
      <CardHeader>
        <CardTitle>{state.tier === 'pro' ? 'Pro plan' : 'Free plan'}</CardTitle>
        {/* The MIRRORED price (never a price id); omitted when the mirrored
            Price carries no unit_amount rather than rendering a broken value. */}
        {subscription && subscription.priceUnitAmount !== null && (
          <CardDescription data-testid="plan-price">
            {formatCurrency(
              subscription.priceUnitAmount / 100,
              subscription.priceCurrency ?? 'USD',
            )}{' '}
            / month
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {subscription &&
          (subscription.cancelAtPeriodEnd ? (
            <p className="text-sm text-muted-foreground" data-testid="plan-cancel-pending">
              Pro until {formatDay(subscription.currentPeriodEnd)}
            </p>
          ) : subscription.pastDue ? null : (
            <p className="text-sm text-muted-foreground" data-testid="plan-renewal">
              Renews {formatDay(subscription.currentPeriodEnd)}
            </p>
          ))}

        {subscription?.pastDue && (
          <p className="text-sm text-destructive" data-testid="plan-past-due">
            Payment past due — update your payment method to keep Pro.
          </p>
        )}

        {showUpgrade && (
          <div className="space-y-3" data-testid="plan-upgrade">
            <ul className="space-y-1 text-sm text-muted-foreground" data-testid="lever-summary">
              {levers.map(({ key, label }) => (
                <li key={key} className="flex justify-between gap-4">
                  <span>{label}</span>
                  <span>
                    {leverValue(key, state.limits.free[key])} →{' '}
                    {leverValue(key, state.limits.pro[key])}
                  </span>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              className="cursor-pointer"
              disabled={subscribe.isPending}
              onClick={onUpgrade}
            >
              Upgrade to Pro
            </Button>
          </div>
        )}

        {/* Portal link keys on `manageable` (subscription row + Stripe
            configured) — never on gating (REQ-4.4). A row without Stripe gets
            the temporarily-unavailable notice instead (REQ-11.1). */}
        {subscription &&
          (subscription.manageable ? (
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              disabled={portal.isPending}
              onClick={onManage}
              data-testid="manage-subscription"
            >
              Manage subscription
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="billing-unavailable">
              Billing is temporarily unavailable — subscription management will return shortly.
            </p>
          ))}

        {bars.length > 0 && (
          <div className="space-y-3" data-testid="usage-warnings">
            {bars.map(({ key, label, used, cap }) => (
              <div key={key} className="space-y-1" data-testid={`usage-${key}`}>
                <div className="flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="text-muted-foreground">
                    {used} / {cap}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-2 rounded-full',
                      used >= cap ? 'bg-destructive' : 'bg-primary',
                    )}
                    style={{ width: `${Math.min(100, Math.round((used / cap) * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

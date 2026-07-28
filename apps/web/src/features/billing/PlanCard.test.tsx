// @vitest-environment jsdom
// PlanCard component states (design §Component 11, D16/D17; REQ-11.1–11.3,
// 11.6–11.7, REQ-2.6, REQ-4.4, REQ-13.1): free+CTA, pro+renewal,
// cancel-pending, past-due, mirror-without-Stripe notice, usage bars, both
// gating-off states, and the confirming poll (resolve / cap / transient error).
//
// Poll timer discipline (pinned in the task): SHORT REAL INTERVALS via the
// PlanCard test seams — no fake timers, so the interval and the microtask
// queue never deadlock each other.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TierLimits, TierState } from '@tradr/shared';

import { api } from '@/lib/api';
import { captureClientEvent } from '@/lib/telemetry/posthog';

import { PlanCard, type PlanCardProps } from './PlanCard';
import { billingKeys } from './useWalletBalance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const FREE_LIMITS: TierLimits = {
  accounts: 1,
  positions: 1000,
  lookbackMonths: 6,
  platformTurns: 5,
  images: 10,
  csvImports: 10,
};

const PRO_LIMITS: TierLimits = {
  accounts: null,
  positions: null,
  lookbackMonths: null,
  platformTurns: 200,
  images: null,
  csvImports: null,
};

const PERIOD_END = '2026-08-15T12:00:00.000Z';
// Same formatter as PlanCard — keeps the assertion timezone-independent.
const PERIOD_END_DAY = new Date(PERIOD_END).toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

type Subscription = NonNullable<TierState['subscription']>;

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    status: 'active',
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    pastDue: false,
    priceUnitAmount: 1000,
    priceCurrency: 'usd',
    manageable: true,
    ...overrides,
  };
}

function tierState(overrides: Partial<TierState> = {}): TierState {
  return {
    gatingEnabled: true,
    exempt: false,
    tier: 'free',
    purchasable: true,
    subscription: null,
    limits: { free: FREE_LIMITS, pro: PRO_LIMITS },
    usage: {
      accounts: { used: 0, writableAccountId: null },
      positions: { used: 0 },
      platformTurns: { allowanceUsed: 0 },
      images: { used: 0 },
      csvImports: { used: 0 },
    },
    ...overrides,
  };
}

function renderCard(props: PlanCardProps = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <PlanCard {...props} />
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

const originalLocation = window.location;

beforeEach(() => {
  // jsdom's real Location rejects cross-document navigation; replace it so the
  // subscribe/portal redirects can be observed.
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/settings/billing' },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.clearAllMocks();
});

describe('PlanCard states', () => {
  it('free + gating + purchasable: upgrade CTA with the Free-vs-Pro lever summary; click fires telemetry, then checkout, then redirects', async () => {
    vi.mocked(api.get).mockResolvedValue(tierState());
    vi.mocked(api.post).mockResolvedValue({ url: 'https://stripe.example/checkout' });
    renderCard();

    expect(await screen.findByTestId('plan-card')).toBeTruthy();
    expect(screen.getByText('Free plan')).toBeTruthy();
    // No subscription row → no price line, no renewal, no portal section.
    expect(screen.queryByTestId('plan-price')).toBeNull();
    expect(screen.queryByTestId('plan-renewal')).toBeNull();
    expect(screen.queryByTestId('manage-subscription')).toBeNull();

    const summary = screen.getByTestId('lever-summary');
    expect(summary.textContent).toContain('Connected accounts');
    expect(summary.textContent).toContain('1 → Unlimited');
    expect(summary.textContent).toContain('6 months → Unlimited');

    const cta = screen.getByRole('button', { name: 'Upgrade to Pro' });
    expect(cta.className).toContain('cursor-pointer');
    fireEvent.click(cta);

    // Telemetry fires synchronously, BEFORE the checkout POST (D17/REQ-13.1).
    expect(captureClientEvent).toHaveBeenCalledWith('upgrade_cta_clicked', {
      surface: 'plan-card',
    });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/billing/subscription/checkout'));
    expect(vi.mocked(captureClientEvent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.post).mock.invocationCallOrder[0],
    );
    await waitFor(() => expect(window.location.href).toBe('https://stripe.example/checkout'));
  });

  it('pro: mirrored price, renewal date, and the Portal link (no upgrade CTA)', async () => {
    vi.mocked(api.get).mockResolvedValue(
      tierState({ tier: 'pro', subscription: subscription(), usage: null }),
    );
    vi.mocked(api.post).mockResolvedValue({ url: 'https://stripe.example/portal' });
    renderCard();

    expect(await screen.findByText('Pro plan')).toBeTruthy();
    expect(screen.getByTestId('plan-price').textContent).toContain('$10.00');
    expect(screen.getByTestId('plan-renewal').textContent).toBe(`Renews ${PERIOD_END_DAY}`);
    expect(screen.queryByTestId('plan-upgrade')).toBeNull();

    const manage = screen.getByTestId('manage-subscription');
    expect(manage.className).toContain('cursor-pointer');
    fireEvent.click(manage);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/billing/subscription/portal'));
    await waitFor(() => expect(window.location.href).toBe('https://stripe.example/portal'));
  });

  it('cancel-pending: "Pro until ‹date›", no renewal line', async () => {
    vi.mocked(api.get).mockResolvedValue(
      tierState({
        tier: 'pro',
        subscription: subscription({ cancelAtPeriodEnd: true }),
        usage: null,
      }),
    );
    renderCard();

    expect(await screen.findByTestId('plan-cancel-pending')).toBeTruthy();
    expect(screen.getByTestId('plan-cancel-pending').textContent).toBe(
      `Pro until ${PERIOD_END_DAY}`,
    );
    expect(screen.queryByTestId('plan-renewal')).toBeNull();
  });

  it('past-due: warning shown, tier stays Pro, no renewal line', async () => {
    vi.mocked(api.get).mockResolvedValue(
      tierState({
        tier: 'pro',
        subscription: subscription({ status: 'past_due', pastDue: true }),
        usage: null,
      }),
    );
    renderCard();

    expect(await screen.findByTestId('plan-past-due')).toBeTruthy();
    expect(screen.getByText('Pro plan')).toBeTruthy();
    expect(screen.queryByTestId('plan-renewal')).toBeNull();
    expect(screen.getByTestId('manage-subscription')).toBeTruthy();
  });

  it('mirror without Stripe: "billing temporarily unavailable" notice, no Portal link, price line omitted when priceUnitAmount is null', async () => {
    vi.mocked(api.get).mockResolvedValue(
      tierState({
        tier: 'pro',
        purchasable: false,
        subscription: subscription({
          manageable: false,
          priceUnitAmount: null,
          priceCurrency: null,
        }),
        usage: null,
      }),
    );
    renderCard();

    expect(await screen.findByTestId('billing-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('manage-subscription')).toBeNull();
    expect(screen.queryByTestId('plan-price')).toBeNull();
  });

  it('usage bars render only for levers at ≥80% of the current tier cap', async () => {
    vi.mocked(api.get).mockResolvedValue(
      tierState({
        usage: {
          accounts: { used: 1, writableAccountId: null }, // 1/1 = 100% → bar
          positions: { used: 800 }, // 800/1000 = 80% → bar
          platformTurns: { allowanceUsed: 1 }, // 1/5 → no bar
          images: { used: 2 }, // 2/10 → no bar
          csvImports: { used: 3 }, // 3/10 → no bar
        },
      }),
    );
    renderCard();

    expect(await screen.findByTestId('usage-warnings')).toBeTruthy();
    expect(screen.getByTestId('usage-accounts').textContent).toContain('1 / 1');
    expect(screen.getByTestId('usage-positions').textContent).toContain('800 / 1000');
    expect(screen.queryByTestId('usage-platformTurns')).toBeNull();
    expect(screen.queryByTestId('usage-images')).toBeNull();
    expect(screen.queryByTestId('usage-csvImports')).toBeNull();
  });
});

describe('PlanCard gating-off states (REQ-11.7)', () => {
  it('gating off + subscription row: the carve-out card — plan state + Portal link only', async () => {
    vi.mocked(api.get).mockResolvedValue(
      tierState({
        gatingEnabled: false,
        tier: 'pro',
        purchasable: false,
        subscription: subscription(),
        usage: null,
      }),
    );
    renderCard();

    expect(await screen.findByTestId('plan-card')).toBeTruthy();
    expect(screen.getByTestId('manage-subscription')).toBeTruthy();
    expect(screen.queryByTestId('plan-upgrade')).toBeNull();
    expect(screen.queryByTestId('usage-warnings')).toBeNull();
  });

  it('gating off + no subscription (true self-host): renders nothing at all', async () => {
    vi.mocked(api.get).mockResolvedValue(
      tierState({
        gatingEnabled: false,
        purchasable: false,
        subscription: null,
        usage: null,
      }),
    );
    const { qc, container } = renderCard();

    await waitFor(() => expect(qc.getQueryState(billingKeys.tier())?.status).toBe('success'));
    expect(container.innerHTML).toBe('');
  });
});

describe('PlanCard confirming poll (REQ-2.6)', () => {
  it('polls the tier until it reads pro, then renders the pro card', async () => {
    const free = tierState();
    const pro = tierState({ tier: 'pro', subscription: subscription(), usage: null });
    let calls = 0;
    vi.mocked(api.get).mockImplementation(() => {
      calls += 1;
      return Promise.resolve(calls < 3 ? free : pro);
    });
    renderCard({ confirming: true, pollIntervalMs: 25, pollCapMs: 5_000 });

    // Banner up (a non-error state), never the free card + CTA underneath.
    expect(screen.getByTestId('subscription-confirming')).toBeTruthy();
    expect(screen.queryByText('Upgrade to Pro')).toBeNull();

    expect(await screen.findByText('Pro plan', undefined, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByTestId('subscription-confirming')).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('after the 60s-equivalent cap: persistent non-error "still confirming" — never a revert to Free + upgrade CTA', async () => {
    vi.mocked(api.get).mockResolvedValue(tierState());
    renderCard({ confirming: true, pollIntervalMs: 25, pollCapMs: 150 });

    expect(
      await screen.findByText(/Still confirming — this can take a minute/, undefined, {
        timeout: 3_000,
      }),
    ).toBeTruthy();

    // The state PERSISTS well past the cap: still the banner, never Free+CTA.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByTestId('subscription-confirming')).toBeTruthy();
    expect(screen.getByText(/Still confirming — this can take a minute/)).toBeTruthy();
    expect(screen.queryByTestId('plan-card')).toBeNull();
    expect(screen.queryByText('Upgrade to Pro')).toBeNull();
  });

  it('a transient error/429 during the poll is "still confirming", never a failure state', async () => {
    const free = tierState();
    const pro = tierState({ tier: 'pro', subscription: subscription(), usage: null });
    let calls = 0;
    vi.mocked(api.get).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(free);
      if (calls <= 3) {
        const err = new Error('Too many requests') as Error & { status?: number };
        err.status = 429;
        return Promise.reject(err);
      }
      return Promise.resolve(pro);
    });
    renderCard({ confirming: true, pollIntervalMs: 25, pollCapMs: 5_000 });

    // The 429s flow past without surfacing anything but "confirming".
    expect(await screen.findByTestId('subscription-confirming')).toBeTruthy();
    expect(screen.queryByText('Upgrade to Pro')).toBeNull();

    // …and the poll recovers to Pro once the webhook lands.
    expect(await screen.findByText('Pro plan', undefined, { timeout: 3_000 })).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(4);
  });
});

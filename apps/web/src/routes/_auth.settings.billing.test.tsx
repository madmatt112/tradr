// @vitest-environment jsdom
// Billing route integration (design §Component 11; REQ-11.7, REQ-2.6):
// state 4 (gating off + no subscription — true self-host) must render
// BYTE-IDENTICAL today's output (header + billing-disabled notice, no plan
// card), and `?subscription=confirming` must mount the confirming banner.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TierState } from '@tradr/shared';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api } from '@/lib/api';

import { Route as BillingRoute } from './_auth.settings.billing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

// Self-host shape: gating off, nothing purchasable, no subscription row —
// the minimal gating-off response GET /api/billing/tier returns (D16).
const SELF_HOST_TIER: TierState = {
  gatingEnabled: false,
  exempt: false,
  tier: 'free',
  purchasable: false,
  subscription: null,
  limits: {
    free: {
      accounts: 1,
      positions: 1000,
      lookbackMonths: 6,
      platformTurns: 5,
      images: 10,
      csvImports: 10,
    },
    pro: {
      accounts: null,
      positions: null,
      lookbackMonths: null,
      platformTurns: 200,
      images: null,
      csvImports: null,
    },
  },
  usage: null,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const billingOpts = BillingRoute.options as any;

// Re-host the real route component + validateSearch under a hand-built tree
// (the settings-account test pattern). The pathless `_auth` layout keeps the
// re-hosted route's id `/_auth/settings/billing`, so the component's
// `Route.useSearch()` resolves against the mounted match.
function buildRouter(initialEntry: string) {
  const rootRoute = createRootRoute();

  const authLayout = createRoute({
    getParentRoute: () => rootRoute as any,
    id: '_auth',
  });

  const billing = createRoute({
    getParentRoute: () => authLayout as any,
    path: '/settings/billing',
    component: billingOpts.component,
    validateSearch: billingOpts.validateSearch,
  });

  const routeTree = rootRoute.addChildren([authLayout.addChildren([billing])]);

  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

function renderRoute(initialEntry: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = buildRouter(initialEntry);
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { qc, router };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path === '/billing/config') {
      return Promise.resolve({ enabled: false, packs: [], models: [] });
    }
    if (path === '/billing/tier') {
      return Promise.resolve(SELF_HOST_TIER);
    }
    return Promise.reject(new Error(`Unexpected GET in test: ${path}`));
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('billing route — gating off, no subscription (REQ-11.7 state 4)', () => {
  it("renders byte-identical today's billing-disabled output, with no plan card", async () => {
    const { qc } = renderRoute('/settings/billing');

    await screen.findByTestId('billing-disabled');
    // Wait until the tier read settled too, so the assertion covers the FINAL
    // output, not a still-loading intermediate.
    await waitFor(() => expect(qc.getQueryState(billingKeys.tier())?.status).toBe('success'));

    expect(screen.queryByTestId('plan-card')).toBeNull();
    expect(screen.queryByTestId('subscription-confirming')).toBeNull();

    // Byte-identical pin: exactly the pre-plan-tiers markup of
    // _auth.settings.billing.tsx's disabled state.
    const tab = document.querySelector('[data-slot="settings-billing"]');
    expect(tab).not.toBeNull();
    expect(tab!.outerHTML).toBe(
      '<div class="space-y-8" data-slot="settings-billing">' +
        '<div><h2 class="text-lg font-medium">Billing</h2>' +
        '<p class="text-sm text-muted-foreground">View your credit balance, buy credits, and review usage.</p>' +
        '</div>' +
        '<p class="text-sm text-muted-foreground" data-testid="billing-disabled">Billing is not enabled on this instance.</p>' +
        '</div>',
    );
  });
});

describe('billing route — ?subscription=confirming (REQ-2.6)', () => {
  it('mounts the confirming banner from the search param', async () => {
    renderRoute('/settings/billing?subscription=confirming');

    expect(await screen.findByTestId('subscription-confirming')).toBeTruthy();
    expect(screen.getByText('Confirming your subscription…')).toBeTruthy();
    // Never Free + upgrade CTA while confirming.
    expect(screen.queryByText('Upgrade to Pro')).toBeNull();
  });

  it('degrades a stray non-string search value to not-confirming instead of crashing', async () => {
    // The router JSON-parses search values, so `?subscription=true` arrives
    // as a boolean. Validation must be total: no error boundary, no banner.
    renderRoute('/settings/billing?subscription=true');

    expect(await screen.findByTestId('billing-disabled')).toBeTruthy();
    expect(screen.queryByTestId('subscription-confirming')).toBeNull();
  });
});

// @vitest-environment jsdom
/* eslint-disable import-x/order */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { DashboardLayoutResponse, WidgetPlacement } from '@tradr/shared';
import type { GridItemHTMLElement } from 'gridstack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Mocks ----------------------------------------------------------------

// useDashboardLayout is the ONLY hook we mock (per Task 45 restriction).
// We expose a `setLayoutMock(...)` knob each test calls before render.
let layoutMockValue: Record<string, unknown> = {};
vi.mock('@/features/dashboard/hooks/useDashboardLayout', () => ({
  useDashboardLayout: () => layoutMockValue,
}));

// useAuth gives the route a user.id. Not a "widget data hook" — the route
// itself depends on it (for the uuidv5 name construction in case 5).
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, isLoading: false, isAuthenticated: true }),
}));

// Toast — we assert calls in case 7.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// uuidv5Batch — case 5 asserts it's called and its output zipped into placements.
vi.mock('@tradr/shared', async () => {
  const actual = await vi.importActual<typeof import('@tradr/shared')>('@tradr/shared');
  return {
    ...actual,
    uuidv5Batch: vi.fn(async (names: string[]) =>
      names.map((_n, i) => `00000000-0000-4000-8000-00000000000${i + 1}`),
    ),
  };
});

// ---- Zero-state mocks ------------------------------------------------------
//
// The route now composes two more reads before it decides what to show. Both
// are faked here, but NOT identically:
//
// `useAccounts` is discriminated on its ARGUMENT. Only the route passes an
// options object (`{ enabled }`); the widget call sites inside the grid —
// AccountBalancesWidget, CrossCurrencyTotal — pass none. So the mock hands the
// route a controllable knob while handing the widgets exactly what they saw in
// this file before the zero-state existed: a failed read, hence their skeleton.
// That is what makes "the existing branches behave as before" a literal claim
// about these tests rather than an approximate one.
//
// `useOnboarding` is faked wholesale rather than only `useOnboardingQuery`,
// because ZeroState and the ActivationChecklist inside it both read the real
// hook. Neither is stubbed: whether a `skipped` user still reaches the reopen
// control is a claim about the COMPOSED screen, and a stubbed checklist would
// let that claim pass while the real one rendered nothing.
type AccountsResult = { data: unknown[] | undefined; isLoading: boolean; isError: boolean };
let accountsMock: AccountsResult = { data: [], isLoading: false, isError: false };
vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: (options?: { enabled?: boolean }): AccountsResult => {
    if (options === undefined) return { data: undefined, isLoading: false, isError: true };
    // The real hook reports `data: undefined` for a disabled query.
    if (options.enabled === false) return { data: undefined, isLoading: false, isError: false };
    return accountsMock;
  },
}));

let onboardingQueryMock: {
  data: OnboardingState | undefined;
  isLoading: boolean;
  isError: boolean;
};
let onboardingMock: UseOnboardingResult;
// `useOnboardingPatch` is here for the coach mark the populated branch mounts:
// it is the only write path that component has, and an unmocked one would throw
// for want of a QueryClient. The mark itself is left REAL — whether it appears
// on this branch and stays off the zero-state and empty ones is a claim about
// this route, and a stub would let it pass.
vi.mock('@/features/onboarding/hooks/useOnboarding', () => ({
  useOnboardingQuery: () => onboardingQueryMock,
  useOnboarding: () => onboardingMock,
  useOnboardingPatch: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Same stub AccountList.test.tsx and ZeroState.test.tsx use: it pulls in
// brokerages, tier state and the API client, none of which this route's
// branching depends on.
vi.mock('@/features/accounts/components/AccountDialog', () => ({
  AccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="account-dialog" /> : null,
}));

import { toast } from 'sonner';
import { uuidv5Batch, DEFAULT_WIDGETS } from '@tradr/shared';
import type { OnboardingState, OnboardingStatus } from '@tradr/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { UseOnboardingResult } from '@/features/onboarding/hooks/useOnboarding';
import { deriveChecklist } from '@/features/onboarding/lib/derive-checklist';
import { Route } from './_auth.dashboard';

const DashboardPage = Route.options.component as () => React.ReactElement;

// ---- Helpers --------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

function renderRoute() {
  const qc = makeQueryClient();
  // A fresh element each time, on the SAME client: `rerenderRoute` has to model
  // a data change arriving at a mounted tree, so nothing may remount.
  const tree = () => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <DashboardPage />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, rerenderRoute: () => result.rerender(tree()) };
}

const sixDefaultWidgets: WidgetPlacement[] = DEFAULT_WIDGETS.map((d, i) => ({
  id: `00000000-0000-4000-8000-aaaaaaaaaaa${i}`,
  type: d.type,
  x: d.x,
  y: d.y,
  w: d.w,
  h: d.h,
}));

function baseLayout(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    data: undefined as DashboardLayoutResponse | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    flushPending: vi.fn(),
    scheduleLayoutWrite: vi.fn(),
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    putTheme: vi.fn(),
    ...overrides,
  };
}

/**
 * Point the two onboarding reads at one status. `undefined` means the cheap
 * preference read has not landed yet.
 *
 * The derived `checklist` MIRRORS the real hook's three values rather than
 * always handing back a checklist, because the route now mounts
 * `ActivationChecklist` on the populated and empty-layout branches and the
 * component branches on all three: `undefined` while the status is unknown,
 * `null` for a `done` or `skipped` user (the reads it would need were never
 * issued), a `Checklist` otherwise. A mock that returned four unticked boxes for
 * a retired user would let a regression pass here that the product would show.
 */
function setOnboarding(
  status: OnboardingStatus | undefined,
  over: Partial<UseOnboardingResult> = {},
) {
  const preference: OnboardingState | undefined =
    status === undefined ? undefined : { status, coachMarksSeen: [] };
  onboardingQueryMock = {
    data: preference,
    isLoading: preference === undefined,
    isError: false,
  };
  const checklistNeeded = status === 'pending' || status === 'active';
  onboardingMock = {
    checklist:
      preference === undefined
        ? undefined
        : checklistNeeded
          ? deriveChecklist({
              accountCount: 0,
              positionsEverCreatedCount: 0,
              closedPositionCount: 0,
            })
          : null,
    preference,
    isLoading: false,
    isError: false,
    isSaving: false,
    setStatus: vi.fn(),
    dismiss: vi.fn(),
    markCoachMarkSeen: vi.fn(),
    ...over,
  };
}

let fetchSpy: MockInstance | null = null;

beforeEach(() => {
  // The coach mark's device latch persists in localStorage now; without this
  // an outside click in one test silences the mark for every test after it.
  localStorage.clear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(uuidv5Batch).mockClear();
  // Cases 1-7 predate the zero-state and must keep behaving exactly as they
  // did, so the default user is one whose onboarding has RETIRED — the gate
  // short-circuits before it ever looks at the account count.
  setOnboarding('done');
  accountsMock = { data: [], isLoading: false, isError: false };
  fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  vi.restoreAllMocks();
});

/** The gridstack item wrapping the card of one widget type, once the grid is up. */
function gridItemOf(container: HTMLElement, type: string): GridItemHTMLElement {
  const card = container.querySelector(`section[data-widget-type="${type}"]`);
  const item = card?.closest('.grid-stack-item') as GridItemHTMLElement | null;
  expect(item, `grid item for ${type}`).not.toBeNull();
  return item!;
}

/** The grid's aside item — the checklist's slot — or null when there is none. */
function asideItem(container: HTMLElement): GridItemHTMLElement | null {
  return container.querySelector('[data-grid-aside]') as GridItemHTMLElement | null;
}

// ---- Tests ----------------------------------------------------------------

describe('_auth.dashboard route', () => {
  it('case 1: initial loading state renders the skeleton grid', () => {
    layoutMockValue = baseLayout({ isLoading: true });
    const { container } = renderRoute();
    const skeleton = container.querySelector('[data-slot="dashboard-skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton!.getAttribute('aria-busy')).toBe('true');
    // 6 default placements → 6 skeleton cells.
    expect(skeleton!.children.length).toBe(6);
  });

  it('case 2: populated grid renders all six default widget chrome cards', async () => {
    layoutMockValue = baseLayout({
      data: { widgets: sixDefaultWidgets, theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' },
    });
    const { container } = renderRoute();
    await waitFor(() => {
      const cards = container.querySelectorAll('[data-widget-id]');
      expect(cards.length).toBeGreaterThanOrEqual(6);
    });
    for (const w of sixDefaultWidgets) {
      const card = container.querySelector(
        `[data-widget-id="${w.id}"][data-widget-type="${w.type}"]`,
      );
      expect(card).not.toBeNull();
    }
  });

  it('case 3: error state renders EmptyState + retry button; clicking retry calls refetch', () => {
    const refetch = vi.fn();
    layoutMockValue = baseLayout({ isError: true, refetch });
    renderRoute();
    expect(screen.getByText("Couldn't load your dashboard")).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('case 4: empty state renders both actions (Add Widget + Use the default layout)', () => {
    layoutMockValue = baseLayout({
      data: { widgets: [], theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' },
    });
    const { container } = renderRoute();
    expect(screen.getByText('Your dashboard is empty')).toBeTruthy();
    expect(container.querySelector('[data-slot="add-widget-trigger"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Use the default layout/i })).toBeTruthy();
  });

  it('case 5: "Use the default layout" click triggers uuidv5Batch then scheduleLayoutWrite with six placements', async () => {
    const scheduleLayoutWrite = vi.fn();
    layoutMockValue = baseLayout({
      data: { widgets: [], theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' },
      scheduleLayoutWrite,
    });
    renderRoute();
    const btn = screen.getByRole('button', { name: /Use the default layout/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(uuidv5Batch).toHaveBeenCalledTimes(1);
      expect(scheduleLayoutWrite).toHaveBeenCalledTimes(1);
    });
    // Verify the merger function passed to scheduleLayoutWrite yields six placements
    // whose types match DEFAULT_WIDGETS in order.
    const merger = scheduleLayoutWrite.mock.calls[0][0] as (prev: {
      widgets?: WidgetPlacement[];
    }) => { widgets: WidgetPlacement[] };
    const result = merger({});
    expect(result.widgets).toHaveLength(6);
    expect(result.widgets.map((w) => w.type)).toEqual(DEFAULT_WIDGETS.map((d) => d.type));
    // Names passed to uuidv5Batch are `${userId}:${type}`.
    const names = vi.mocked(uuidv5Batch).mock.calls[0][0] as string[];
    expect(names).toEqual(DEFAULT_WIDGETS.map((d) => `user-1:${d.type}`));
  });

  it('case 5b: layout mergers compose onto the pending write instead of replacing it', async () => {
    // Regression guard. `scheduleLayoutWrite` debounces 300ms behind ONE pending
    // body, so a handler that ignores the pending value discards whatever edit
    // is already queued. A widget config fix-up landing just after a drag used
    // to re-send the pre-drag positions, silently reverting the drag — for any
    // drag within ~1.5s of page load. It also dropped a queued `theme` write.
    const scheduleLayoutWrite = vi.fn();
    // One type missing so the Add Widget picker has an entry to click.
    const placed = sixDefaultWidgets.filter((w) => w.type !== 'equity-curve');
    layoutMockValue = baseLayout({
      data: { widgets: placed, theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' },
      scheduleLayoutWrite,
    });
    renderRoute();

    fireEvent.click(screen.getAllByRole('button', { name: /Add Widget/i })[0]);
    fireEvent.click(await screen.findByText('Equity Curve'));
    expect(scheduleLayoutWrite).toHaveBeenCalledTimes(1);

    const merger = scheduleLayoutWrite.mock.calls[0][0] as (prev: {
      widgets?: WidgetPlacement[];
      theme?: string;
    }) => { widgets: WidgetPlacement[]; theme?: string };

    // A drag is already queued: same widgets, moved. The merger must build on
    // THOSE positions, not resurrect the ones from the query cache.
    const dragged = placed.map((w) => ({ ...w, y: w.y + 20 }));
    const result = merger({ widgets: dragged, theme: 'dark' });

    // The queued theme survives.
    expect(result.theme).toBe('dark');
    // Every pre-existing widget keeps its DRAGGED position.
    for (const w of dragged) {
      expect(result.widgets.find((r) => r.id === w.id)?.y).toBe(w.y);
    }
    // And the add still happened.
    expect(result.widgets).toHaveLength(dragged.length + 1);
    expect(result.widgets.map((w) => w.type)).toContain('equity-curve');
  });

  it('case 6: beforeunload listener fires flushPending on unload', () => {
    const flushPending = vi.fn();
    layoutMockValue = baseLayout({
      data: { widgets: sixDefaultWidgets, theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' },
      flushPending,
    });
    renderRoute();
    expect(flushPending).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('beforeunload'));
    expect(flushPending).toHaveBeenCalledTimes(1);
  });

  it('case 7 (v2-9): oversized pending body on beforeunload triggers toast.error and does NOT call fetch', () => {
    // Option A: stub flushPending to simulate the real-hook oversized branch —
    // call toast.error and skip the keepalive fetch entirely.
    const flushPending = vi.fn(() => {
      toast.error('Layout too large; remove a widget or reduce its configuration');
      // Intentionally do NOT call fetch.
    });
    layoutMockValue = baseLayout({
      data: { widgets: sixDefaultWidgets, theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' },
      flushPending,
    });
    renderRoute();
    // Clear any incidental fetch calls from render-time data hooks (widget bodies
    // may attempt their own fetches; we only care that flushPending itself does NOT
    // issue the keepalive PUT).
    vi.mocked(global.fetch).mockClear();
    window.dispatchEvent(new Event('beforeunload'));
    expect(flushPending).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Layout too large'));
    // Assert no keepalive PUT was emitted by flushPending.
    const keepaliveCalls = vi.mocked(global.fetch).mock.calls.filter((args) => {
      const init = args[1] as RequestInit | undefined;
      return init?.keepalive === true;
    });
    expect(keepaliveCalls.length).toBe(0);
  });
});

// ---- Zero state ------------------------------------------------------------

describe('_auth.dashboard route — the zero-state gate', () => {
  const populated = {
    widgets: sixDefaultWidgets,
    theme: 'light',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
  const emptyLayout = { widgets: [], theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' };
  const oneAccount = [{ id: 'acct-1' }];

  it('gives a fresh user the zero-state instead of six empty widgets', () => {
    // The layout is fully populated, so without the gate this user would be
    // looking at the grid — the exact screen the zero-state exists to replace.
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('pending');
    accountsMock = { data: [], isLoading: false, isError: false };
    const { container } = renderRoute();
    expect(screen.getByTestId('onboarding-zero-state')).toBeTruthy();
    expect(container.querySelector('[data-widget-id]')).toBeNull();
    expect(container.querySelector('[data-slot="dashboard-skeleton"]')).toBeNull();
  });

  it('takes precedence over the empty-layout state', () => {
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding('pending');
    accountsMock = { data: [], isLoading: false, isError: false };
    renderRoute();
    expect(screen.getByTestId('onboarding-zero-state')).toBeTruthy();
    expect(screen.queryByText('Your dashboard is empty')).toBeNull();
  });

  it('swaps to the grid with no reload when the first account is created', async () => {
    // `useCreateAccount` invalidates ['accounts'] and the route observes
    // ['accounts', 'list'], so a real create produces exactly this data change.
    // What is pinned here is the route's reaction to it: the SAME mounted tree
    // re-renders into the grid — nothing is remounted and no reload happens.
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('pending');
    accountsMock = { data: [], isLoading: false, isError: false };
    const { container, rerenderRoute } = renderRoute();
    expect(screen.getByTestId('onboarding-zero-state')).toBeTruthy();

    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    rerenderRoute();

    await waitFor(() => {
      expect(container.querySelectorAll('[data-widget-id]').length).toBeGreaterThanOrEqual(6);
    });
    expect(screen.queryByTestId('onboarding-zero-state')).toBeNull();
  });

  it('a user who already has an account never sees the zero-state', () => {
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding('pending');
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    renderRoute();
    expect(screen.queryByTestId('onboarding-zero-state')).toBeNull();
    expect(screen.getByText('Your dashboard is empty')).toBeTruthy();
  });

  it('gives a retired user with zero accounts the empty layout, not the zero-state', () => {
    // The returning user who deleted every account. `done` is the whole reason
    // the stored status exists — the account count alone cannot tell them apart
    // from someone who registered a minute ago.
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding('done');
    accountsMock = { data: [], isLoading: false, isError: false };
    renderRoute();
    expect(screen.queryByTestId('onboarding-zero-state')).toBeNull();
    expect(screen.getByText('Your dashboard is empty')).toBeTruthy();
  });

  it('still gives a SKIPPED user with zero accounts the zero-state, and with it the reopen control', () => {
    // The trap this gate is most likely to fall into. Retiring on
    // `done || skipped` would look harmless — but ActivationChecklist's
    // "Reopen setup checklist" row is the only way back from a dismissal
    // anywhere in the product, and the zero-state is the only screen that
    // mounts the checklist. Gate on `skipped` too and dismissal stops being
    // recoverable, with nothing in the checklist's own tests to notice.
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding('skipped', { checklist: null });
    accountsMock = { data: [], isLoading: false, isError: false };
    renderRoute();
    expect(screen.getByTestId('onboarding-zero-state')).toBeTruthy();
    expect(screen.getByTestId('activation-checklist-reopen')).toBeTruthy();
  });

  it('no flash: holds the skeleton rather than showing the grid while the status is unknown', () => {
    // An established user must not see the zero-state for a beat, and a brand
    // new one must not see the grid. Neither can be decided until the status
    // has landed, so the route stays on the skeleton it is already showing.
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding(undefined);
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const { container } = renderRoute();
    expect(container.querySelector('[data-slot="dashboard-skeleton"]')).not.toBeNull();
    expect(container.querySelector('[data-widget-id]')).toBeNull();
    expect(screen.queryByTestId('onboarding-zero-state')).toBeNull();
  });

  it('no flash: holds the skeleton rather than showing the zero-state while the accounts read is in flight', () => {
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('pending');
    accountsMock = { data: undefined, isLoading: true, isError: false };
    const { container } = renderRoute();
    expect(container.querySelector('[data-slot="dashboard-skeleton"]')).not.toBeNull();
    expect(screen.queryByTestId('onboarding-zero-state')).toBeNull();
  });

  it('a failed onboarding read falls through to the dashboard instead of parking on the skeleton', () => {
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding(undefined);
    onboardingQueryMock = { data: undefined, isLoading: false, isError: true };
    accountsMock = { data: [], isLoading: false, isError: false };
    const { container } = renderRoute();
    expect(container.querySelector('[data-slot="dashboard-skeleton"]')).toBeNull();
    expect(screen.getByText('Your dashboard is empty')).toBeTruthy();
  });

  it('a failed accounts read falls through to the dashboard too', () => {
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding('pending');
    accountsMock = { data: undefined, isLoading: false, isError: true };
    const { container } = renderRoute();
    expect(container.querySelector('[data-slot="dashboard-skeleton"]')).toBeNull();
    expect(screen.getByText('Your dashboard is empty')).toBeTruthy();
  });

  it('leaves the isLoading and isError branches unchanged', () => {
    // Both sit ahead of the zero-state, so they must win even for the user the
    // zero-state is for.
    layoutMockValue = baseLayout({ isLoading: true });
    setOnboarding('pending');
    accountsMock = { data: [], isLoading: false, isError: false };
    const first = renderRoute();
    expect(first.container.querySelector('[data-slot="dashboard-skeleton"]')).not.toBeNull();
    expect(screen.queryByTestId('onboarding-zero-state')).toBeNull();
    cleanup();

    layoutMockValue = baseLayout({ isError: true });
    renderRoute();
    expect(screen.getByText("Couldn't load your dashboard")).toBeTruthy();
    expect(screen.queryByTestId('onboarding-zero-state')).toBeNull();
  });
});

// ---- The checklist beyond the zero-state ------------------------------------
//
// `ZeroState` mounts `ActivationChecklist` itself, and for a while that was the
// checklist's ONLY home — which meant it disappeared from the product the
// instant the user created their first account. Items 2-4 became invisible
// exactly when they were the outstanding work; the reopen row that keeps a
// dismissal recoverable became unreachable; and the checklist could never retire
// itself on the fourth completed item, so the status never reached `done` and
// the gated reads never switched off. These cases pin the mount on the two
// branches a user with accounts actually lands on.

describe('_auth.dashboard route — the activation checklist beyond the zero-state', () => {
  const populated = {
    widgets: sixDefaultWidgets,
    theme: 'light',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
  const emptyLayout = { widgets: [], theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' };
  const oneAccount = [{ id: 'acct-1' }];
  const allDone = deriveChecklist({
    accountCount: 1,
    positionsEverCreatedCount: 1,
    closedPositionCount: 1,
    calculatorFirstUsedAt: '2026-05-01T00:00:00.000Z',
  });

  it('a user with an account and pending onboarding sees the checklist IN the grid, locked top-right', async () => {
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('pending');
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const { container } = renderRoute();

    const checklist = screen.getByTestId('activation-checklist');
    // Items 2-4 are the outstanding work for this user, so they must be on
    // screen — that is the whole point of mounting past the zero-state.
    expect(screen.getByText('Size a trade in the calculator')).toBeTruthy();
    expect(screen.getByText('Log a position')).toBeTruthy();
    expect(screen.getByText('Close it and see the stats')).toBeTruthy();

    await waitFor(() => {
      expect(asideItem(container)).not.toBeNull();
    });
    // One item among the widgets — not a card bolted on above them — locked in
    // the top-right slot at the right-rail width and the Stats Summary's height.
    const aside = asideItem(container)!;
    expect(aside.contains(checklist)).toBe(true);
    expect(aside.gridstackNode).toMatchObject({
      x: 8,
      y: 0,
      w: 4,
      h: 6,
      locked: true,
      noMove: true,
      noResize: true,
    });
    // Stats Summary narrows to sit beside it; the rest of the default layout
    // is where it was.
    expect(gridItemOf(container, 'stats-summary').gridstackNode).toMatchObject({
      x: 0,
      y: 0,
      w: 8,
      h: 6,
    });
    expect(gridItemOf(container, 'account-balances').gridstackNode).toMatchObject({
      x: 8,
      y: 6,
      w: 4,
      h: 12,
    });
    // Making room is a view of the stored layout, never a write to it.
    expect(layoutMockValue.scheduleLayoutWrite).not.toHaveBeenCalled();
    // Exactly one mount: nothing above the grid.
    expect(screen.getAllByTestId('activation-checklist')).toHaveLength(1);
    expect(container.querySelector('[data-grid-mode]')!.contains(checklist)).toBe(true);
  });

  it('the empty-layout branch mounts it too, and keeps its own empty state', () => {
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding('pending');
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    renderRoute();
    expect(screen.getByTestId('activation-checklist')).toBeTruthy();
    // The branch itself is untouched.
    expect(screen.getByText('Your dashboard is empty')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Use the default layout/i })).toBeTruthy();
  });

  it('a retired (done) user with accounts sees no checklist and the grid keeps its full width', async () => {
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('done');
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const { container } = renderRoute();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
    expect(screen.queryByTestId('activation-checklist-loading')).toBeNull();
    expect(screen.queryByTestId('activation-checklist-reopen')).toBeNull();
    await waitFor(() => {
      expect(container.querySelector('[data-grid-mode]')).not.toBeNull();
    });
    // No slot is held for the majority, who are exactly who this branch is for.
    expect(asideItem(container)).toBeNull();
    expect(gridItemOf(container, 'stats-summary').gridstackNode).toMatchObject({
      x: 0,
      y: 0,
      w: 12,
      h: 6,
    });
  });

  it('a SKIPPED user with accounts still reaches the reopen row — dismissal stays recoverable', () => {
    // Before the checklist had a home here, creating the first account deleted
    // the product's only way back from a dismissal.
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('skipped');
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    renderRoute();
    expect(screen.getByTestId('activation-checklist-reopen')).toBeTruthy();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
  });

  it('completing all four items retires the checklist and writes `done` once', async () => {
    // Reachable ONLY from this mount: items 2-4 cannot be completed by a user
    // who still qualifies for the zero-state, so retirement could never fire
    // while the zero-state was the checklist's only home — and with it the read
    // gate that turns the accounts and positions queries off stayed open.
    const setStatus = vi.fn();
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('active', { checklist: allDone, setStatus });
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const renderResult = renderRoute();
    await waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith('done');
    });
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
    // And the grid never held a slot for a checklist that was already finished.
    expect(asideItem(renderResult.container)).toBeNull();
  });

  it('no flash: nothing is rendered when the route falls through with the status still unknown', () => {
    // The route normally holds the skeleton until the preference lands, so this
    // branch is only reachable via a failed read — and there the checklist must
    // occupy no space rather than paint a card an established user then loses.
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding(undefined);
    onboardingQueryMock = { data: undefined, isLoading: false, isError: true };
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const { container } = renderRoute();
    expect(container.querySelector('[data-slot="dashboard-skeleton"]')).toBeNull();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
    expect(screen.queryByTestId('activation-checklist-loading')).toBeNull();
  });

  it('mounts no checklist of its own in the loading, error and zero-state branches', () => {
    layoutMockValue = baseLayout({ isLoading: true });
    setOnboarding('pending');
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const first = renderRoute();
    expect(first.container.querySelector('[data-slot="dashboard-skeleton"]')).not.toBeNull();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
    cleanup();

    layoutMockValue = baseLayout({ isError: true });
    renderRoute();
    expect(screen.getByText("Couldn't load your dashboard")).toBeTruthy();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
    cleanup();

    // And the zero-state is not double-mounted: ZeroState composes the checklist
    // itself, so exactly one must be on screen there.
    layoutMockValue = baseLayout({ data: populated });
    accountsMock = { data: [], isLoading: false, isError: false };
    renderRoute();
    expect(screen.getByTestId('onboarding-zero-state')).toBeTruthy();
    expect(screen.getAllByTestId('activation-checklist')).toHaveLength(1);
  });
});

// ---- The checklist's loading state holds the card's grid item ---------------
//
// `ActivationChecklist` paints a skeleton while its derived reads are in
// flight. Mounted bare above the widget grid it was once 28px shorter than the
// card that replaced it, and the whole grid dropped by that much, once per
// load, for every user still mid-onboarding — the loading-state layout jump the
// design system forbids. In the grid the geometry is the item's, not the
// content's, and the skeleton matches the card row for row besides. jsdom
// computes no layout, so these cases pin what it CAN see: the skeleton mounts
// in the aside item, and the card then refills that SAME item.

describe('_auth.dashboard route — the checklist skeleton holds the same grid item as the card', () => {
  const populated = {
    widgets: sixDefaultWidgets,
    theme: 'light',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
  const emptyLayout = { widgets: [], theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' };
  const oneAccount = [{ id: 'acct-1' }];
  const someChecklist = deriveChecklist({
    accountCount: 1,
    positionsEverCreatedCount: 0,
    closedPositionCount: 0,
  });

  it('mounts the skeleton in the aside slot, and the card refills that same item', async () => {
    layoutMockValue = baseLayout({ data: populated });
    // Preference landed, gated reads still in flight: the one window in which
    // the skeleton is on screen.
    setOnboarding('pending', { checklist: undefined });
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const { container, rerenderRoute } = renderRoute();

    await waitFor(() => {
      expect(asideItem(container)).not.toBeNull();
    });
    const slot = asideItem(container)!;
    expect(slot.contains(screen.getByTestId('activation-checklist-loading'))).toBe(true);
    expect(slot.gridstackNode).toMatchObject({ x: 8, y: 0, w: 4, h: 6 });

    // The positions read lands and the card replaces the skeleton.
    setOnboarding('pending', { checklist: someChecklist });
    rerenderRoute();

    expect(screen.queryByTestId('activation-checklist-loading')).toBeNull();
    // SAME item — the grid was told nothing changed, so nothing around it moved.
    const after = asideItem(container)!;
    expect(after).toBe(slot);
    expect(after.contains(screen.getByTestId('activation-checklist'))).toBe(true);
  });

  it('mounts the skeleton on the empty-layout branch too, above the empty state', () => {
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding('pending', { checklist: undefined });
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    renderRoute();

    expect(screen.getByTestId('activation-checklist-loading')).toBeTruthy();
    // And the branch's own content is unchanged.
    expect(screen.getByText('Your dashboard is empty')).toBeTruthy();
  });

  it('does not reintroduce the flash of four unticked boxes', () => {
    // The slot must not tempt anyone into rendering the card early to fill it.
    // While the reads are in flight the user sees a skeleton and the four item
    // labels are nowhere on screen.
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('pending', { checklist: undefined });
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    renderRoute();

    expect(screen.getByTestId('activation-checklist-loading')).toBeTruthy();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
    expect(screen.queryByText('Create a brokerage account')).toBeNull();
    expect(screen.queryByText('Log a position')).toBeNull();
  });
});

// ---- The widget coach mark --------------------------------------------------
//
// The mark rides with the populated branch's header and MUST NOT reach the two
// branches that return before it. That is a property of the route's branch
// ORDER, which is exactly the kind of thing an edit elsewhere in this file
// moves by accident, so it is pinned here rather than left to be read off the
// source.
//
// The zero-state is the case that matters. That screen exists to get one thing
// done — the user's first account — and a popover about arranging widgets,
// painted over it, competes with the single action `ZeroState` is built around
// while describing a grid the user cannot see. The empty branch renders neither
// the cards nor the Reset layout button the copy names, which is the same
// mistake in a quieter form.
//
// The component is left REAL in this file (only its write hook is faked, see
// the mock block at the top) precisely so these cases are about the route.

describe('_auth.dashboard route — the widget coach mark', () => {
  const populated = {
    widgets: sixDefaultWidgets,
    theme: 'light',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
  const emptyLayout = { widgets: [], theme: 'light', updatedAt: '2026-05-01T00:00:00.000Z' };
  const oneAccount = [{ id: 'acct-1' }];

  it('appears beside the header on the populated branch', () => {
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('pending');
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const { container } = renderRoute();

    expect(screen.getByTestId('coach-mark-dashboard-widgets')).toBeTruthy();
    // INSIDE the header, beside the heading — not merely somewhere on the page,
    // and not at the right-hand end of the row, which is where it used to sit.
    // A coach mark opens BELOW its anchor, so an anchor at the right-hand end
    // opens the card over the column the dashboard keeps its buttons in: the
    // checklist's per-item play buttons, and the widget card menus once the
    // checklist has retired. Measured at 1280x720, its "Got it" landed exactly
    // on the play button for "Log a position" — the control that restarts a
    // walkthrough. The e2e suite measures that; this pins the structure the
    // measurement depends on.
    const anchor = container.querySelector('[data-slot="coach-mark-anchor"]');
    expect(anchor).not.toBeNull();
    const header = anchor!.closest('[data-slot="dashboard-header"]');
    expect(header).not.toBeNull();
    // Beside the heading specifically: same parent, heading first.
    // The desk header grammar prefixes the aria-hidden ▴ mark, so the text
    // CONTAINS the name rather than equalling it.
    expect(anchor!.parentElement!.querySelector('h1')?.textContent).toContain('Dashboard');
  });

  it('stays off the zero-state, which has one thing to say and is entitled to say it', () => {
    // Same populated layout as above — only the account count differs, so a
    // pass here is about the branch that wins and nothing else.
    layoutMockValue = baseLayout({ data: populated });
    setOnboarding('pending');
    accountsMock = { data: [], isLoading: false, isError: false };
    const { container } = renderRoute();

    expect(screen.getByTestId('onboarding-zero-state')).toBeTruthy();
    expect(screen.queryByTestId('coach-mark-dashboard-widgets')).toBeNull();
    // Absent, not merely empty: the branch returns before the mark is mounted.
    expect(container.querySelector('[data-slot="coach-mark-anchor"]')).toBeNull();
  });

  it('stays off the empty-layout branch, which renders none of the controls it names', () => {
    layoutMockValue = baseLayout({ data: emptyLayout });
    setOnboarding('pending');
    accountsMock = { data: oneAccount, isLoading: false, isError: false };
    const { container } = renderRoute();

    expect(screen.getByText('Your dashboard is empty')).toBeTruthy();
    expect(screen.queryByTestId('coach-mark-dashboard-widgets')).toBeNull();
    expect(container.querySelector('[data-slot="coach-mark-anchor"]')).toBeNull();
  });
});

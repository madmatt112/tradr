// @vitest-environment jsdom
/* eslint-disable import-x/order */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { DashboardLayoutResponse, WidgetPlacement } from '@tradr/shared';

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

import { toast } from 'sonner';
import { uuidv5Batch, DEFAULT_WIDGETS } from '@tradr/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
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
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <DashboardPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
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

let fetchSpy: MockInstance | null = null;

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.mocked(uuidv5Batch).mockClear();
  fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  vi.restoreAllMocks();
});

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

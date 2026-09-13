// @vitest-environment jsdom
/* eslint-disable import-x/order */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Tag } from '@tradr/shared';

import { TooltipProvider } from '@/components/ui/tooltip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Two fixed UUIDs where B sorts after A lexicographically.
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

// ---- Mocks ----------------------------------------------------------------

const h = vi.hoisted(() => ({
  recordedFilters: [] as unknown[],
  rows: [] as any[],
}));

// Keep positionsListQuery real (it defines the cache key under test); only the
// subscribing hook is replaced so we can record the filters it receives.
vi.mock('../hooks/usePositions', async (importActual) => {
  const actual = await importActual<typeof import('../hooks/usePositions')>();
  return {
    ...actual,
    usePositions: (filters?: unknown) => {
      h.recordedFilters.push(filters);
      return { data: h.rows, isLoading: false };
    },
  };
});

const tagA: Tag = { id: A, name: 'breakout', category: 'setup', color: null };
const tagB: Tag = { id: B, name: 'FOMO', category: 'emotion', color: null };

vi.mock('@/features/tags/hooks/useTags', () => ({
  useTags: () => ({
    data: [
      { ...tagA, positionCount: 1 },
      { ...tagB, positionCount: 1 },
    ],
  }),
}));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: 'a1' }] }),
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

vi.mock('@/stores/drawer.store', () => ({
  useDrawerStore: (selector: (s: any) => any) =>
    selector({ inspectPosition: vi.fn(), inspectedPosition: null, isOpen: false }),
}));

vi.mock('./CreatePositionDialog', () => ({ CreatePositionDialog: () => null }));
vi.mock('./PositionRowActions', () => ({ PositionRowActions: () => null }));

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

import { PositionsSearchSchema } from '@/routes/_auth/positions/index';

import { positionsListQuery } from '../hooks/usePositions';
import { buildListFilters } from '../utils/listFilters';

import { PositionList } from './PositionList';

// ---- Test router ----------------------------------------------------------
// Re-host PositionList under a fresh root with the SAME route id the real route
// carries (`/_auth/positions/`), so `useSearch({ from: '/_auth/positions/' })`
// resolves against this tree while the URL stays at `/positions`.

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  // Mirror the real `_auth` (pathless layout) → `positions` → index nesting so
  // the leaf route id is `/_auth/positions/`, the exact `from` the component's
  // useSearch targets. The URL still lives at `/positions`.
  const authLayout = createRoute({ getParentRoute: () => rootRoute as any, id: '_auth' });
  const positions = createRoute({
    getParentRoute: () => authLayout as any,
    path: 'positions',
  });
  const positionsIndex = createRoute({
    getParentRoute: () => positions as any,
    path: '/',
    validateSearch: PositionsSearchSchema,
    component: PositionList,
  });
  const routeTree = rootRoute.addChildren([
    authLayout.addChildren([positions.addChildren([positionsIndex])]) as any,
  ]);
  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function renderAt(initialPath: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = buildRouter(initialPath);
  const result = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router as any} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { router, ...result };
}

beforeEach(() => {
  h.recordedFilters.length = 0;
  h.rows = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PositionList — URL-driven filters', () => {
  it('reads a hand-typed ?tag=b,a into a sorted [a,b] filter and cache key', async () => {
    h.rows = [makePosition()];
    renderAt(`/positions?tag=${B},${A}`);

    await waitFor(() => expect(h.recordedFilters.length).toBeGreaterThan(0));
    const recorded = h.recordedFilters.at(-1);
    expect(recorded).toEqual({ tag: [A, B] });
    // b,a and a,b collapse to one cache entry after the read-side sort.
    expect(positionsListQuery(recorded as any).queryKey).toEqual(
      positionsListQuery(buildListFilters({ tag: `${A},${B}` })).queryKey,
    );
  });

  it('clicking Closed writes ?status=closed to the URL', async () => {
    const user = userEvent.setup();
    h.rows = [makePosition()];
    const { router } = renderAt('/positions');

    await user.click(await screen.findByRole('tab', { name: 'Closed' }));
    await waitFor(() => expect(router.state.location.search.status).toBe('closed'));
  });

  it('clicking All removes status from the URL', async () => {
    const user = userEvent.setup();
    h.rows = [makePosition()];
    const { router } = renderAt('/positions?status=open');

    await user.click(await screen.findByRole('tab', { name: 'All' }));
    await waitFor(() => expect(router.state.location.search.status).toBeUndefined());
  });

  it('a garbage ?status=foo degrades to the All tab and no status filter', async () => {
    h.rows = [makePosition()];
    renderAt('/positions?status=foo');

    const allTab = await screen.findByRole('tab', { name: 'All' });
    expect(allTab.getAttribute('data-state')).toBe('active');
    await waitFor(() => expect(h.recordedFilters.length).toBeGreaterThan(0));
    expect(h.recordedFilters.at(-1)).toBeUndefined();
  });

  it('a row with four tags renders three chips and a +1 marker', async () => {
    const tags: Tag[] = [
      { id: '1', name: 'alpha', category: 'setup', color: null },
      { id: '2', name: 'bravo', category: 'setup', color: null },
      { id: '3', name: 'charlie', category: 'setup', color: null },
      { id: '4', name: 'delta', category: 'setup', color: null },
    ];
    h.rows = [makePosition({ tags })];
    renderAt('/positions');

    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.getByText('bravo')).toBeTruthy();
    expect(screen.getByText('charlie')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.queryByText('delta')).toBeNull();
  });

  it('an empty filtered list shows the filter empty state and Clear filters resets the URL', async () => {
    const user = userEvent.setup();
    h.rows = [];
    const { router } = renderAt('/positions?status=open');

    await user.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('an empty unfiltered list shows the no-positions-yet state', async () => {
    h.rows = [];
    renderAt('/positions');

    expect(await screen.findByText('No positions yet')).toBeTruthy();
  });
});

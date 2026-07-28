// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Mocks ----------------------------------------------------------------

// The auth layout gates every /_auth child on this hook; the advisor routes are
// what is under test, not the guard.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    isLoading: false,
    isAuthenticated: true,
    logout: { mutate: vi.fn(), isPending: false },
  }),
}));

// The advisor surface itself is NOT under test — every hook it mounts fetches.
// The stub reports the props the ROUTE handed it, which is exactly the contract
// this file exists to protect: which route component mounted, with which id.
vi.mock('@/features/advisor/pages/AdvisorPage', () => ({
  AdvisorPage: ({
    conversationId,
    isNew = false,
  }: {
    conversationId: string | null;
    isNew?: boolean;
  }) => (
    <div
      data-testid="advisor-page"
      data-conversation-id={conversationId ?? 'null'}
      data-is-new={String(isNew)}
    />
  ),
}));

import { routeTree } from '@/routeTree.gen';

// ---- Harness --------------------------------------------------------------
// The REAL generated route tree, deliberately. The regression this guards was a
// tree-shape bug: `_auth.advisor.tsx` was the parent of `$id`/`new` and rendered
// no <Outlet />, so the matched child never mounted and every /advisor/{id} URL
// fell back to the parent's conversationId={null} render. A hand-built router
// (the settings-layout.test.tsx pattern) would construct the FIXED shape by hand
// and pass against the broken tree — only the generated tree can catch it.

async function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  // findBy — the route components lazy-import the page behind a Suspense boundary.
  return screen.findByTestId('advisor-page');
}

describe('advisor route tree', () => {
  afterEach(cleanup);

  it('renders /advisor/{id} with the id from the URL', async () => {
    const page = await renderAt('/advisor/c87b56b5-6fda-420a-ba5f-507dafa45476');

    // The assertion that fails on the broken tree: it read 'null' there, because
    // the parent route rendered instead of the matched $id child.
    expect(page.dataset.conversationId).toBe('c87b56b5-6fda-420a-ba5f-507dafa45476');
    expect(page.dataset.isNew).toBe('false');
  });

  it('renders /advisor with no active conversation', async () => {
    const page = await renderAt('/advisor');

    expect(page.dataset.conversationId).toBe('null');
    expect(page.dataset.isNew).toBe('false');
  });

  it('renders /advisor/new in new-conversation mode', async () => {
    const page = await renderAt('/advisor/new');

    // Also broken on the old tree: the parent rendered with isNew unset, which
    // hid the composer once the conversation list was non-empty.
    expect(page.dataset.isNew).toBe('true');
    expect(page.dataset.conversationId).toBe('null');
  });
});

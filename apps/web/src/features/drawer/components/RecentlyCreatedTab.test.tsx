// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useNow } from '@/hooks/useNow';
import { useDrawerStore } from '@/stores/drawer.store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stub TanStack Router's <Link> with a plain anchor so we can assert hrefs
// and click behaviour without booting a router context. The `params` prop is
// interpolated into `to` (`$positionId` → params.positionId) so we can assert
// navigation targets via rendered hrefs.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    className,
    onClick,
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
    className?: string;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => {
    let href = to;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        href = href.replace(`$${k}`, v);
      }
    }
    return (
      <a
        href={href}
        className={className}
        onClick={(e) => {
          e.preventDefault();
          onClick?.(e);
        }}
      >
        {children}
      </a>
    );
  },
}));

vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: vi.fn(),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: vi.fn(() => false),
}));

vi.mock('@/hooks/useNow', () => ({
  useNow: vi.fn(() => new Date('2026-05-27T12:00:00.000Z')),
}));

import { RecentlyCreatedTab } from './RecentlyCreatedTab';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountWith(ui: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

function unmount(container: HTMLElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

beforeEach(() => {
  vi.mocked(usePositions).mockReset();
  vi.mocked(useMediaQuery).mockReset();
  vi.mocked(useMediaQuery).mockReturnValue(false);
  vi.mocked(useNow).mockReset();
  vi.mocked(useNow).mockReturnValue(new Date('2026-05-27T12:00:00.000Z'));
  useDrawerStore.setState({ isOpen: false, activeTab: 'open-positions' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecentlyCreatedTab', () => {
  it('renders skeleton placeholders while loading', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<RecentlyCreatedTab />);
    const skeletons = container.querySelectorAll('[data-testid="recently-created-skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
    unmount(container, root);
  });

  it('renders a destructive Alert on error', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('kaboom'),
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<RecentlyCreatedTab />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('kaboom');
    unmount(container, root);
  });

  it('renders empty-state copy and a link to /positions when there are no positions', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<RecentlyCreatedTab />);
    expect(container.textContent).toContain('No positions yet. Create your first position.');
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/positions');
    unmount(container, root);
  });

  it('renders action labels for draft/open/closed rows', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-0000-0000-0000000000d1',
        symbol: 'X',
        status: 'draft',
        createdAt: '2026-05-27T11:00:00.000Z',
      }),
      makePosition({
        id: '00000000-0000-0000-0000-0000000000d2',
        symbol: 'Y',
        status: 'open',
        createdAt: '2026-05-27T10:00:00.000Z',
      }),
      makePosition({
        id: '00000000-0000-0000-0000-0000000000d3',
        symbol: 'Z',
        status: 'closed',
        createdAt: '2026-05-27T09:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<RecentlyCreatedTab />);
    const text = container.textContent ?? '';
    expect(text).toContain('Drafted X');
    expect(text).toContain('Active: Y');
    expect(text).toContain('Closed Z');
    unmount(container, root);
  });

  it('renders only the top 20 most-recent positions by createdAt', () => {
    // 25 rows with strictly-increasing createdAt timestamps.
    const rows = Array.from({ length: 25 }, (_, i) =>
      makePosition({
        id: `00000000-0000-0000-0000-0000000000${(i + 10).toString().padStart(2, '0')}`,
        symbol: `S${i.toString().padStart(2, '0')}`,
        status: 'open',
        // i=0 oldest, i=24 newest. Use distinct minute offsets.
        createdAt: `2026-05-01T${(10 + i).toString().padStart(2, '0')}:00:00.000Z`,
      }),
    );
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<RecentlyCreatedTab />);
    const links = container.querySelectorAll('a');
    expect(links.length).toBe(20);

    const expectedTop20Ids = rows
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((p) => p.id);
    const renderedHrefs = Array.from(links).map((a) => a.getAttribute('href'));
    const expectedHrefs = expectedTop20Ids.map((id) => `/positions/${id}`);
    expect(renderedHrefs).toEqual(expectedHrefs);

    unmount(container, root);
  });

  it('closes the drawer on row click when on mobile', () => {
    vi.mocked(useMediaQuery).mockReturnValue(true);
    const rows = [
      makePosition({
        id: '00000000-0000-0000-0000-0000000000e1',
        symbol: 'AAPL',
        status: 'open',
        createdAt: '2026-05-27T11:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    useDrawerStore.setState({ isOpen: true });

    const { container, root } = mountWith(<RecentlyCreatedTab />);
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/positions/00000000-0000-0000-0000-0000000000e1');

    act(() => {
      link!.click();
    });

    expect(useDrawerStore.getState().isOpen).toBe(false);
    unmount(container, root);
  });
});

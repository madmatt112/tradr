// @vitest-environment jsdom
// AdminPage + StatsCards (admin-platform Task 18; REQ-7.1/7.3, REQ-2.3).
//
// Covers both not-authorized paths — the client-side `user.isAdmin === false`
// convenience gate AND the backend 403, asserted against the real error
// envelope the api client throws ({ error: { code, message }, status }) where
// the code lives at `err.error?.code` — plus the stats cards with the pinned
// labels ("Active now (last 30 min)", "purchased-credit volume").
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}));

// Stub TanStack Router's <Link> with a plain anchor so the page mounts
// without a router context (Sidebar.test.tsx pattern).
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const mockAuth = vi.hoisted(() => ({
  user: null as { id: string; email: string; isAdmin: boolean } | null,
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockAuth.user,
    isLoading: false,
    isAuthenticated: mockAuth.user !== null,
    login: { mutate: vi.fn() },
    logout: { mutate: vi.fn() },
  }),
}));

import { AdminPage } from '../AdminPage';

const ADMIN_USER = { id: '11111111-1111-1111-1111-111111111111', email: 'a@x.com', isAdmin: true };
const PLAIN_USER = { id: '22222222-2222-2222-2222-222222222222', email: 'u@x.com', isAdmin: false };

// The real envelope shape: the api client throws the parsed JSON body with
// `status` patched on (api.ts) — the code is at `error.code`, NOT top-level.
const ADMIN_REQUIRED_ENVELOPE = {
  error: { code: 'ADMIN_REQUIRED', message: 'Admin access required' },
  status: 403,
};

const STATS = {
  totalUsers: 42,
  activeUsers: 7,
  activeUsersWindowMinutes: 30,
  positions: { total: 100, draft: 5, open: 25, closed: 70 },
  revenue: { allTime: '125000000', currentMonth: '10000000', basis: 'purchased-credit-volume' },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return render(<AdminPage />, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminPage — not-authorized state', () => {
  it('renders "Not authorized" with a dashboard link when user.isAdmin === false', () => {
    mockAuth.user = PLAIN_USER;
    vi.mocked(api.get).mockRejectedValue(ADMIN_REQUIRED_ENVELOPE);

    renderPage();

    expect(screen.getByText('Not authorized')).toBeTruthy();
    const back = screen.getByText('Back to dashboard');
    expect(back.getAttribute('href')).toBe('/dashboard');
    expect(back.className).toContain('cursor-pointer');
  });

  it('renders "Not authorized" when an admin query 403s with the ADMIN_REQUIRED envelope', async () => {
    // Stale client state: the user object still claims admin, the backend says no.
    mockAuth.user = ADMIN_USER;
    vi.mocked(api.get).mockRejectedValue(ADMIN_REQUIRED_ENVELOPE);

    renderPage();

    expect(await screen.findByText('Not authorized')).toBeTruthy();
    expect(screen.getByText('Back to dashboard').getAttribute('href')).toBe('/dashboard');
  });

  it('does NOT render the not-authorized state for other error codes', async () => {
    mockAuth.user = ADMIN_USER;
    vi.mocked(api.get).mockRejectedValue({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      status: 429,
    });

    renderPage();

    expect(await screen.findByText('Failed to load stats.')).toBeTruthy();
    expect(screen.queryByText('Not authorized')).toBeNull();
  });
});

describe('AdminPage — stats cards', () => {
  it('renders seeded stats with the pinned labels', async () => {
    mockAuth.user = ADMIN_USER;
    vi.mocked(api.get).mockResolvedValue(STATS);

    renderPage();

    // Pinned labels (design §Component 11).
    expect(await screen.findByText('Active now (last 30 min)')).toBeTruthy();
    expect(screen.getByText('purchased-credit volume')).toBeTruthy();

    // Seeded values.
    expect(screen.getByText('42')).toBeTruthy(); // totalUsers
    expect(screen.getByText('7')).toBeTruthy(); // activeUsers
    expect(screen.getByText('100')).toBeTruthy(); // positions.total
    expect(screen.getByText('5 draft · 25 open · 70 closed')).toBeTruthy();

    // Revenue is micro-USD → USD for display (1 credit = 1 micro-USD).
    const usd = (micro: string) =>
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
        Number(micro) / 1_000_000,
      );
    expect(screen.getByText(usd('125000000'))).toBeTruthy();
    expect(screen.getByText(`${usd('10000000')} this month`)).toBeTruthy();

    // All three sections are present.
    expect(screen.getByText('Stats')).toBeTruthy();
    expect(screen.getByText('Users')).toBeTruthy();
    expect(screen.getByText('Usage')).toBeTruthy();
  });

  it('renders zero-value cards (not errors) for a fresh instance', async () => {
    mockAuth.user = ADMIN_USER;
    vi.mocked(api.get).mockResolvedValue({
      totalUsers: 0,
      activeUsers: 0,
      activeUsersWindowMinutes: 30,
      positions: { total: 0, draft: 0, open: 0, closed: 0 },
      revenue: { allTime: '0', currentMonth: '0', basis: 'purchased-credit-volume' },
    });

    renderPage();

    expect(await screen.findByText('Active now (last 30 min)')).toBeTruthy();
    expect(screen.getByText('0 draft · 0 open · 0 closed')).toBeTruthy();
    expect(screen.queryByText('Failed to load stats.')).toBeNull();
    expect(screen.queryByText('Not authorized')).toBeNull();
  });

  it('renders Skeleton placeholders while stats load', async () => {
    mockAuth.user = ADMIN_USER;
    let resolve!: (v: unknown) => void;
    vi.mocked(api.get).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }) as never,
    );

    const { container } = renderPage();

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);

    resolve(STATS);
    await waitFor(() => expect(screen.getByText('Active now (last 30 min)')).toBeTruthy());
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });
});

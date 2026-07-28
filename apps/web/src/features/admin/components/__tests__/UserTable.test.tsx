// @vitest-environment jsdom
// UserTable (admin-platform Task 19; REQ-3.1/3.2/3.3/3.4, REQ-7.4, REQ-7.6).
//
// Covers: the mandatory confirm-dialog flow before any toggle mutation
// (including the extra-explicit self-demotion copy), LAST_ADMIN (409) surfaced
// from err.error?.code as the inline "Cannot remove the last admin" error,
// `—` rendering for never-active users, cursor "Load more" pagination, and the
// detail dialog over useAdminUser.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn() },
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

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

import { UserTable } from '../UserTable';

const SELF_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ADMIN_ID = '22222222-2222-2222-2222-222222222222';
const PLAIN_ID = '33333333-3333-3333-3333-333333333333';

const SELF = {
  id: SELF_ID,
  email: 'me@x.com',
  isAdmin: true,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-06-10T12:00:00.000Z',
};
// Unverified — the Verified column renders the neutral em dash.
const OTHER_ADMIN = {
  id: OTHER_ADMIN_ID,
  email: 'admin2@x.com',
  isAdmin: true,
  emailVerified: false,
  createdAt: '2026-02-01T00:00:00.000Z',
  lastActiveAt: '2026-06-01T12:00:00.000Z',
};
// Never active — lastActiveAt NULL.
const PLAIN = {
  id: PLAIN_ID,
  email: 'user@x.com',
  isAdmin: false,
  emailVerified: true,
  createdAt: '2026-03-01T00:00:00.000Z',
  lastActiveAt: null,
};

const PAGE_ONE = { items: [SELF, OTHER_ADMIN, PLAIN], nextCursor: null };

// The house envelope the api client throws: code at err.error?.code.
const LAST_ADMIN_ENVELOPE = {
  error: { code: 'LAST_ADMIN', message: 'Cannot demote the last admin' },
  status: 409,
};

function mockUsersList(response: unknown = PAGE_ONE) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.startsWith('/admin/users?') || url === '/admin/users') {
      return Promise.resolve(response as never);
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return render(<UserTable />, { wrapper });
}

function dialog(): HTMLElement {
  const el = document.querySelector('[data-slot="dialog-content"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UserTable — rendering', () => {
  it('renders users with email, admin badges, and — for never-active users', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    mockUsersList();

    renderTable();

    expect(await screen.findByText('me@x.com')).toBeTruthy();
    expect(screen.getByText('admin2@x.com')).toBeTruthy();
    expect(screen.getByText('user@x.com')).toBeTruthy();

    // Admin badge on the two admins only.
    expect(screen.getAllByText('Admin', { selector: '[data-slot="badge"]' }).length).toBe(2);

    // NULL lastActiveAt renders as the em dash.
    const plainRow = screen.getByText('user@x.com').closest('tr')!;
    expect(within(plainRow).getByText('—')).toBeTruthy();
    // Active users do not get the dash.
    const selfRow = screen.getByText('me@x.com').closest('tr')!;
    expect(within(selfRow).queryByText('—')).toBeNull();
  });

  it('renders the read-only Verified column: neutral check when verified, — when not (REQ-5.7)', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    mockUsersList();

    renderTable();

    expect(await screen.findByText('me@x.com')).toBeTruthy();
    expect(screen.getByText('Verified')).toBeTruthy();

    // Verified users get the neutral check; no action is attached to it.
    const selfRow = screen.getByText('me@x.com').closest('tr')!;
    expect(within(selfRow).getByLabelText('me@x.com verified')).toBeTruthy();

    // Unverified users get the em dash instead of the check.
    const unverifiedRow = screen.getByText('admin2@x.com').closest('tr')!;
    expect(within(unverifiedRow).queryByLabelText('admin2@x.com verified')).toBeNull();
    expect(within(unverifiedRow).getByText('—')).toBeTruthy();
  });

  it('loads the next page via the cursor when "Load more" is clicked', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    const pageTwoUser = {
      id: '44444444-4444-4444-4444-444444444444',
      email: 'older@x.com',
      isAdmin: false,
      emailVerified: true,
      createdAt: '2025-12-01T00:00:00.000Z',
      lastActiveAt: null,
    };
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/admin/users') {
        return Promise.resolve({ items: [SELF], nextCursor: 'cursor-2' } as never);
      }
      if (url === '/admin/users?cursor=cursor-2') {
        return Promise.resolve({ items: [pageTwoUser], nextCursor: null } as never);
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    renderTable();

    const loadMore = await screen.findByRole('button', { name: 'Load more' });
    expect(loadMore.className).toContain('cursor-pointer');
    await userEvent.click(loadMore);

    // Page two appended; page one still visible; no further cursor → button gone.
    expect(await screen.findByText('older@x.com')).toBeTruthy();
    expect(screen.getByText('me@x.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('UserTable — toggle confirm dialog', () => {
  it('requires confirmation: the switch alone never fires the mutation, Cancel aborts', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    mockUsersList();

    renderTable();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Toggle admin access for user@x.com' }),
    );

    // Dialog opened with the promotion copy; no mutation yet.
    expect(within(dialog()).getByText('Grant admin access to user@x.com?')).toBeTruthy();
    expect(api.patch).not.toHaveBeenCalled();

    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('confirming a promotion calls the toggle mutation and closes the dialog', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    mockUsersList();
    vi.mocked(api.patch).mockResolvedValue({
      id: PLAIN_ID,
      email: 'user@x.com',
      isAdmin: true,
      createdAt: PLAIN.createdAt,
    } as never);

    renderTable();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Toggle admin access for user@x.com' }),
    );
    const confirm = within(dialog()).getByRole('button', { name: 'Grant admin access' });
    expect(confirm.className).toContain('cursor-pointer');
    await userEvent.click(confirm);

    expect(api.patch).toHaveBeenCalledWith(`/admin/users/${PLAIN_ID}/admin`, { isAdmin: true });
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull());
  });

  it('uses distinct demotion copy for another admin', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    mockUsersList();

    renderTable();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Toggle admin access for admin2@x.com' }),
    );

    expect(within(dialog()).getByText('Remove admin access from admin2@x.com?')).toBeTruthy();
    expect(within(dialog()).queryByText(/You are removing your own admin access/)).toBeNull();
  });

  it('shows the extra-explicit copy on self-demotion', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    mockUsersList();

    renderTable();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Toggle admin access for me@x.com' }),
    );

    expect(within(dialog()).getByText(/You are removing your own admin access/)).toBeTruthy();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('surfaces LAST_ADMIN (409) as the inline "Cannot remove the last admin" error', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    mockUsersList();
    vi.mocked(api.patch).mockRejectedValue(LAST_ADMIN_ENVELOPE);

    renderTable();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Toggle admin access for me@x.com' }),
    );
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Remove admin access' }));

    // Inline error in the still-open dialog + toast; code read at err.error?.code.
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(within(dialog()).getByText('Cannot remove the last admin')).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith('Cannot remove the last admin');
  });

  it('shows a generic error for non-LAST_ADMIN failures', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    mockUsersList();
    vi.mocked(api.patch).mockRejectedValue({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      status: 429,
    });

    renderTable();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Toggle admin access for user@x.com' }),
    );
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Grant admin access' }));

    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(within(dialog()).getByText('Failed to update admin access. Try again.')).toBeTruthy();
    expect(within(dialog()).queryByText('Cannot remove the last admin')).toBeNull();
  });
});

describe('UserTable — detail view', () => {
  it('opens the detail dialog over useAdminUser with counts, usage sums, and wallet balance', async () => {
    mockAuth.user = { id: SELF_ID, email: 'me@x.com', isAdmin: true };
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/admin/users') return Promise.resolve(PAGE_ONE as never);
      if (url === `/admin/users/${PLAIN_ID}`) {
        return Promise.resolve({
          ...PLAIN,
          positionCount: 12,
          advisorTurns: 34,
          usage: { inputTokens: '5000', outputTokens: '6000', billedCredits: '7000' },
          walletBalance: '2500000',
        } as never);
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    renderTable();

    const plainRow = (await screen.findByText('user@x.com')).closest('tr')!;
    const details = within(plainRow).getByRole('button', { name: 'Details' });
    expect(details.className).toContain('cursor-pointer');
    await userEvent.click(details);

    expect(await within(dialog()).findByText('Positions')).toBeTruthy();
    expect(within(dialog()).getByText('12')).toBeTruthy();
    // Plan-tiers REQ-8.3: the stat counts platform-key turns only, and the
    // label says so (the api-side schema description changed with it).
    expect(
      within(dialog()).getByText('Platform-key advisor turns (current UTC month)'),
    ).toBeTruthy();
    expect(within(dialog()).queryByText('Advisor turns (this month)')).toBeNull();
    expect(within(dialog()).getByText('34')).toBeTruthy();
    expect(within(dialog()).getByText('5000')).toBeTruthy();
    expect(within(dialog()).getByText('6000')).toBeTruthy();
    expect(within(dialog()).getByText('7000')).toBeTruthy();
    // Wallet balance: micro-USD → USD display (2,500,000 micro-USD = $2.50).
    const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
      2.5,
    );
    expect(within(dialog()).getByText(usd)).toBeTruthy();
    // Never-active user shows the dash in the detail too.
    expect(within(dialog()).getByText('—')).toBeTruthy();
  });
});

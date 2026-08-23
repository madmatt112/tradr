// @vitest-environment jsdom
// Admin sidebar link conditional (admin-platform Task 18; REQ-7.2).
//
// Lives in its own file (not Sidebar.test.tsx) so it can mock ThemeToggle —
// the real one pulls useAppTheme → useQueryClient, which has a known
// pre-existing failure without a QueryClientProvider in the legacy suite.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub TanStack Router's <Link> with a plain anchor (Sidebar.test.tsx pattern).
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

// ThemeToggle needs a QueryClient; irrelevant to the link conditional.
// The pin preference is a useQuery + useMutation pair under the hood; pin the
// mock EXPANDED so the label-text assertions below read the visible nav.
vi.mock('@/features/onboarding/hooks/useSidebarPin', () => ({
  useSidebarPin: () => ({ pinned: true, setPinned: () => {} }),
}));

vi.mock('@/components/layout/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));

// The stored reporting timezone is a useQuery; stub it so the sidebar mounts
// standalone and the Performance item is navigable.
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => 'America/New_York',
}));

// The Sidebar's changelog badge query also needs a QueryClient; stub the
// module covering BOTH consumed exports (a hook-only factory would TypeError).
vi.mock('@/features/changelog/hooks/useChangelog', () => ({
  useChangelogReleases: () => ({ data: undefined, isError: false }),
  hasNewReleases: () => false,
}));

// Mutable user so each test picks its own isAdmin value.
const mockAuth = vi.hoisted(() => ({
  user: null as { email: string; isAdmin: boolean } | null,
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockAuth.user,
    logout: { mutate: vi.fn() },
  }),
}));

import { Sidebar } from './Sidebar';

function adminLink(container: HTMLElement): HTMLAnchorElement | undefined {
  return Array.from(container.querySelectorAll('a')).find(
    (a) => a.getAttribute('href') === '/admin',
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Sidebar — Admin link conditional', () => {
  it('renders the Admin link for admin users, closing the System group, with cursor-pointer', () => {
    mockAuth.user = { email: 'admin@example.com', isAdmin: true };
    const { container } = render(<Sidebar />);

    const link = adminLink(container);
    expect(link).toBeDefined();
    expect(link?.textContent).toContain('Admin');
    expect(link?.className).toContain('cursor-pointer');

    const hrefs = Array.from(container.querySelectorAll('nav a')).map((a) =>
      a.getAttribute('href'),
    );
    // The desk nav's SYSTEM group closes with Admin (Settings → Changelog →
    // Docs → Admin), so it is the last nav entry rather than Settings + 1.
    expect(hrefs.indexOf('/admin')).toBeGreaterThan(hrefs.indexOf('/settings'));
    expect(hrefs.indexOf('/admin')).toBe(hrefs.length - 1);
  });

  it('does NOT render the Admin link for non-admin users', () => {
    mockAuth.user = { email: 'user@example.com', isAdmin: false };
    const { container } = render(<Sidebar />);

    expect(adminLink(container)).toBeUndefined();
    // No existing link is affected by the conditional.
    expect(
      Array.from(container.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === '/settings',
      ),
    ).toBeDefined();
  });

  it('does NOT render the Admin link when no user is loaded', () => {
    mockAuth.user = null;
    const { container } = render(<Sidebar />);

    expect(adminLink(container)).toBeUndefined();
  });
});

// @vitest-environment jsdom
// MobileNav (design C5, Requirement 5): the md:hidden header control that
// opens every sidebar destination as a modal overlay below 768 px.
//
// MobileNav.tsx does not exist yet (task 8 builds it) — every test below
// fails on the `from './MobileNav'` import until it does.
//
// Mocks mirror Sidebar.test.tsx exactly: the router `Link`, `useAuth`, the
// changelog releases hook and the advisor posture hook. `SidebarNav` and
// `SidebarSession` (task 7) are the REAL components — MobileNav is expected
// to compose them, so mocking them away would hide the composition this
// component exists to provide. `useDrawerStore` is the real zustand store,
// driven directly the way Sidebar.test.tsx drives it.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub TanStack Router's <Link> with a plain anchor, the same shape
// Sidebar.test.tsx uses, so SidebarNav mounts standalone and clicking a
// rendered link both navigates (recorded) and forwards MobileNav's
// `onNavigate` handler.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
    onClick,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
  } & Record<string, unknown>) => (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

// useAuth pulls in TanStack Query + Router internals; stub it the same shape
// Sidebar.test.tsx uses so SidebarNav/SidebarSession mount standalone.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { email: 'test@example.com' },
    logout: { mutate: vi.fn() },
  }),
}));

// The instance posture (GET /api/config) is a useQuery; stub it so the advisor
// item renders without a provider.
vi.mock('@/hooks/useRegistrationEnabled', () => ({
  useAdvisorEnabled: () => true,
}));

// ThemeToggle needs a QueryClient (useAppTheme → useQueryClient); irrelevant
// here — same mock Sidebar.test.tsx uses for SidebarSession.
vi.mock('@/components/layout/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));

// Stub the changelog releases hook the same way Sidebar.test.tsx does: a real
// useQuery would throw without a provider.
vi.mock('@/features/changelog/hooks/useChangelog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/changelog/hooks/useChangelog')>();
  return {
    ...actual,
    useChangelogReleases: () => ({ data: undefined, isError: false }),
  };
});

import { useDrawerStore } from '@/stores/drawer.store';

import { MobileNav } from './MobileNav';

beforeEach(() => {
  useDrawerStore.setState({ isOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openOverlay(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
}

// ---------------------------------------------------------------------------
// Contract: the trigger opens the overlay and closes the side drawer
//
// Pre-condition: MobileNav is mounted with the side drawer already open
//   (`useDrawerStore.setState({ isOpen: true })`).
// Call: click the header's `aria-label="Open navigation"` button.
// Observable result: a dialog with the accessible name "Navigation" is in the
//   document, and `useDrawerStore.getState().isOpen` is false.
// Source of expected value: design.md C5 — the header holds "the Radix dialog
//   trigger"; "Opening calls `useDrawerStore.getState().close()`"
//   (Requirement 5.1, 5.4).
// ---------------------------------------------------------------------------
describe('MobileNav — trigger', () => {
  it('opens the overlay and closes the side drawer when clicked', () => {
    useDrawerStore.setState({ isOpen: true });
    render(<MobileNav />);

    openOverlay();

    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();
    expect(useDrawerStore.getState().isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contract: opening the side drawer closes the overlay
//
// Pre-condition: MobileNav is mounted and its overlay has been opened via the
//   trigger.
// Call: `useDrawerStore.getState().open()`.
// Observable result: the "Navigation" dialog is no longer in the document.
// Source of expected value: design.md C5 — "an effect subscribed to the
//   drawer store closes the overlay when `isOpen` turns true" (Requirement
//   5.4).
// ---------------------------------------------------------------------------
describe('MobileNav — drawer/overlay mutual exclusion', () => {
  it('closes the overlay when the side drawer opens', () => {
    render(<MobileNav />);
    openOverlay();
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();

    act(() => {
      useDrawerStore.getState().open();
    });

    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contract: a navigation click closes the overlay
//
// Pre-condition: the overlay is open.
// Call: click the "Dashboard" link inside it.
// Observable result: the "Navigation" dialog is no longer in the document.
// Source of expected value: design.md C5/tasks.md task 8 Prompt — "the nav
// task 7 exports with `expanded` and an `onNavigate` that closes the
// overlay" (Requirement 5.3).
// ---------------------------------------------------------------------------
describe('MobileNav — navigation closes the overlay', () => {
  it('closes the overlay when a destination link is clicked', () => {
    render(<MobileNav />);
    openOverlay();

    const dashboardLink = screen.getByRole('link', { name: 'Dashboard' });
    fireEvent.click(dashboardLink);

    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contract: every destination and Log out are reachable from the overlay
//
// Pre-condition: the overlay is open, with the default mocks (advisor
//   offered, no admin user).
// Call: none further — read the open overlay's contents.
// Observable result: a link for every sidebar destination the default
//   mocks render, and a "Log out" button, are all inside the dialog.
// Source of expected value: Requirement 5.2 — "every destination... the
//   sidebar carries (including log out...) reachable from the mobile
//   navigation."
// ---------------------------------------------------------------------------
describe('MobileNav — every destination is reachable', () => {
  it('lists every sidebar destination and Log out inside the overlay', () => {
    render(<MobileNav />);
    openOverlay();

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    const destinations = [
      'Dashboard',
      'Advisor',
      'Positions',
      'Calculator',
      'Options',
      'Import',
      'Performance',
      'Accounting',
      'Accounts',
      'Brokerages',
      'Settings',
      'Changelog',
      'Docs',
    ];

    for (const name of destinations) {
      expect(within(dialog).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(dialog).getByRole('button', { name: 'Log out' })).toBeTruthy();
  });
});

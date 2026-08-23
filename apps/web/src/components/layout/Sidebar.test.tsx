// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stub TanStack Router's <Link> with a plain anchor so the smoke test can
// inspect href / text / click navigation without booting a router context.
// Capturing clicks here lets us assert the typo-catching contract: a
// `to="/performanc2"` regression would surface in both the rendered href AND
// the captured click target.
const linkClicks: Array<{ to: string }> = [];
// The `search` prop each Link was last rendered with, keyed by destination.
// The Performance link seeds the route's default window, so this is how we
// assert WHICH timezone that window is anchored at.
const linkSearch = new Map<string, unknown>();
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
    search,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
    search?: unknown;
  } & Record<string, unknown>) => {
    linkSearch.set(to, search);
    return (
      <a
        href={to}
        className={className}
        onClick={(e) => {
          e.preventDefault();
          linkClicks.push({ to });
        }}
        {...rest}
      >
        {children}
      </a>
    );
  },
}));

// useAuth pulls in TanStack Query + Router internals; stub it with a static
// shape so the sidebar mounts standalone.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { email: 'test@example.com' },
    logout: { mutate: vi.fn() },
  }),
}));

// ThemeToggle needs a QueryClient (useAppTheme → useQueryClient); irrelevant
// here — same mock the admin-link suite already uses.
vi.mock('@/components/layout/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));

// Stub the changelog releases hook (a real useQuery would throw without a
// provider — and a provider would let real fetches fire in jsdom). The mock
// factory must cover BOTH consumed exports; `hasNewReleases` is kept real so
// the badge tests exercise the actual predicate.
const changelogState = vi.hoisted(() => ({
  result: { data: undefined as unknown, isError: false },
}));
vi.mock('@/features/changelog/hooks/useChangelog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/changelog/hooks/useChangelog')>();
  return {
    ...actual,
    useChangelogReleases: () => changelogState.result,
  };
});

// The pin preference is a useQuery + useMutation pair under the hood; stub it
// with a controllable value. Most suites run EXPANDED (labels in the DOM) so
// text assertions read naturally; the rail-state suite flips it.
const pinState = vi.hoisted(() => ({
  pinned: true,
  calls: [] as boolean[],
}));
vi.mock('@/features/onboarding/hooks/useSidebarPin', () => ({
  useSidebarPin: () => ({
    pinned: pinState.pinned,
    setPinned: (next: boolean) => {
      pinState.calls.push(next);
    },
  }),
}));

import { useDrawerStore } from '@/stores/drawer.store';

import { Sidebar } from './Sidebar';

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
  linkClicks.length = 0;
  linkSearch.clear();
  localStorage.clear();
  changelogState.result = { data: undefined, isError: false };
  pinState.pinned = true;
  pinState.calls = [];
  useDrawerStore.setState({ isOpen: false });
});

function releasesData(publishedAt: string, lastViewedAt: string) {
  return {
    releases: [
      {
        id: '1',
        name: 'v1.0.0',
        tag: 'v1.0.0',
        publishedAt,
        body: 'notes',
        htmlUrl: 'https://github.com/madmatt112/tradr/releases/tag/v1.0.0',
        prerelease: false,
      },
    ],
    fetchedAt: '2026-06-01T00:00:00.000Z',
    stale: false,
    lastViewedAt,
  };
}

function changelogBadge(container: HTMLElement): Element | undefined {
  const link = Array.from(container.querySelectorAll('a')).find(
    (a) => a.getAttribute('href') === '/changelog',
  );
  return Array.from(link?.querySelectorAll('span.sr-only') ?? []).find(
    (s) => s.textContent === 'New updates available',
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sidebar — Performance link', () => {
  it('renders a link with text "Performance" and href "/performance"', () => {
    const { container, root } = mountWith(<Sidebar />);

    const performanceLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/performance',
    );
    expect(performanceLink).toBeDefined();
    expect(performanceLink?.textContent).toContain('Performance');

    unmount(container, root);
  });

  it('renders the Performance link heading the Review group, after the Trade group', () => {
    const { container, root } = mountWith(<Sidebar />);

    const hrefs = Array.from(container.querySelectorAll('nav a')).map((a) =>
      a.getAttribute('href'),
    );
    const calcIdx = hrefs.indexOf('/calculator');
    const importIdx = hrefs.indexOf('/import');
    const perfIdx = hrefs.indexOf('/performance');
    const acctIdx = hrefs.indexOf('/accounts');

    // The desk nav groups: Performance opens REVIEW, directly after TRADE's
    // last item (Import), with Accounts later in the same group.
    expect(calcIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(calcIdx);
    expect(perfIdx).toBe(importIdx + 1);
    expect(acctIdx).toBeGreaterThan(perfIdx);

    unmount(container, root);
  });

  it('navigates to /performance when the link is clicked', () => {
    const { container, root } = mountWith(<Sidebar />);

    const performanceLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/performance',
    );
    expect(performanceLink).toBeDefined();

    act(() => {
      performanceLink!.click();
    });

    expect(linkClicks).toEqual([{ to: '/performance' }]);

    unmount(container, root);
  });

  it('uses cursor-pointer styling on the Performance link', () => {
    const { container, root } = mountWith(<Sidebar />);

    const performanceLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/performance',
    );
    expect(performanceLink?.className).toContain('cursor-pointer');

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// The Performance route derives its own monthly-preset defaults at the route
// boundary now (visual-redesign 2.4), so the nav item is a PLAIN link: no
// seeded search window, no inert state while the stored timezone loads.
// ---------------------------------------------------------------------------

describe('Sidebar — Performance link is plain', () => {
  it('seeds no search params', () => {
    const { container, root } = mountWith(<Sidebar />);

    expect(linkSearch.get('/performance')).toBeUndefined();

    unmount(container, root);
  });

  it('renders no inert placeholder — the link is always navigable', () => {
    const { container, root } = mountWith(<Sidebar />);

    expect(container.querySelector('nav span[aria-disabled="true"]')).toBeNull();

    unmount(container, root);
  });
});

describe('Sidebar — Changelog link + new-updates badge', () => {
  it('renders the Changelog link in the System group after Settings, with cursor-pointer', () => {
    const { container, root } = mountWith(<Sidebar />);

    const hrefs = Array.from(container.querySelectorAll('nav a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs.indexOf('/changelog')).toBeGreaterThanOrEqual(0);
    // Ordering, not adjacency. The desk nav's SYSTEM group runs Settings →
    // Changelog → Docs, so Changelog sits after Settings now; pinning `+ 1`
    // would make every future nav insertion look like a regression here.
    expect(hrefs.indexOf('/changelog')).toBeGreaterThan(hrefs.indexOf('/settings'));

    const link = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/changelog',
    );
    expect(link?.textContent).toContain('Changelog');
    expect(link?.className).toContain('cursor-pointer');

    unmount(container, root);
  });

  it('renders the badge (with sr-only name) for a newer-than-floor release', () => {
    changelogState.result = {
      data: releasesData('2026-06-10T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
      isError: false,
    };
    const { container, root } = mountWith(<Sidebar />);

    const srOnly = changelogBadge(container);
    expect(srOnly).toBeDefined();
    // Visual dot: the sr-only name lives inside the bg-primary indicator.
    expect(srOnly?.parentElement?.className).toContain('bg-primary');

    unmount(container, root);
  });

  it('hides the badge on query error (no data)', () => {
    changelogState.result = { data: undefined, isError: true };
    const { container, root } = mountWith(<Sidebar />);

    expect(changelogBadge(container)).toBeUndefined();

    unmount(container, root);
  });

  it('hides the badge when the newest release is older than the viewed floor', () => {
    changelogState.result = {
      data: releasesData('2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
      isError: false,
    };
    const { container, root } = mountWith(<Sidebar />);

    expect(changelogBadge(container)).toBeUndefined();

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// The two chrome states (visual-redesign task 4): a 56px icon rail by default,
// pinnable to the 208px labeled state, auto-collapsing while the drawer is
// open. Accessible names never depend on the state — they are aria-labels.
// ---------------------------------------------------------------------------

describe('Sidebar — rail and expanded chrome states', () => {
  it('unpinned renders the icon rail: no inline labels, aria-labels intact', () => {
    pinState.pinned = false;
    const { container, root } = mountWith(<Sidebar />);

    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('w-14');

    // No visible label text in the rail…
    const dashboard = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/dashboard',
    );
    expect(dashboard?.textContent).toBe('');
    // …but the accessible name and the hover label are both present.
    expect(dashboard?.getAttribute('aria-label')).toBe('Dashboard');
    expect(dashboard?.getAttribute('title')).toBe('Dashboard');

    unmount(container, root);
  });

  it('pinned renders the labeled state: 208px, visible labels, group headings', () => {
    pinState.pinned = true;
    const { container, root } = mountWith(<Sidebar />);

    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('w-52');

    const dashboard = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/dashboard',
    );
    expect(dashboard?.textContent).toContain('Dashboard');
    // No title tooltip while the label is visible.
    expect(dashboard?.getAttribute('title')).toBeNull();

    // The TRADE / REVIEW / SYSTEM group headings are in the DOM.
    const text = container.querySelector('nav')?.textContent ?? '';
    expect(text).toContain('Trade');
    expect(text).toContain('Review');
    expect(text).toContain('System');

    unmount(container, root);
  });

  it('the pin control toggles the preference', () => {
    pinState.pinned = false;
    const { container, root } = mountWith(<Sidebar />);

    const expand = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Expand sidebar',
    );
    expect(expand).toBeDefined();
    act(() => {
      expand!.click();
    });
    expect(pinState.calls).toEqual([true]);

    unmount(container, root);
  });

  it('auto-collapses to the rail while the drawer is open, even when pinned', () => {
    pinState.pinned = true;
    useDrawerStore.setState({ isOpen: true });
    const { container, root } = mountWith(<Sidebar />);

    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('w-14');
    // The pin itself is untouched — collapse is derived, not written back.
    expect(pinState.calls).toEqual([]);

    unmount(container, root);
  });
});

// jsdom computes no layout, so these assert the class contract that keeps the
// rail pinned to the viewport instead of stretching to the height of <main> —
// the arrangement that used to scroll the Log out button out of sight on long
// routes.
describe('Sidebar — pinned to the viewport, not the page', () => {
  it('sizes the rail to the viewport and sticks it to the top', () => {
    const { container, root } = mountWith(<Sidebar />);

    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('sticky');
    expect(aside?.className).toContain('top-0');
    expect(aside?.className).toContain('h-screen');

    unmount(container, root);
  });

  it('scrolls the nav links rather than the footer off the bottom', () => {
    const { container, root } = mountWith(<Sidebar />);

    const nav = container.querySelector('nav');
    expect(nav?.className).toContain('overflow-y-auto');
    // Without `min-h-0` the flex child refuses to shrink below its content and
    // pushes the footer past the bottom edge — the bug this guards.
    expect(nav?.className).toContain('min-h-0');

    unmount(container, root);
  });

  it('keeps the Log out button in a footer that cannot be compressed', () => {
    const { container, root } = mountWith(<Sidebar />);

    const logout = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Log out',
    );
    expect(logout).toBeDefined();
    // The footer wraps the session row in an inner flex div now; the
    // uncompressible boundary is the closest shrink-0 ancestor.
    expect(logout?.closest('.shrink-0')).not.toBeNull();

    unmount(container, root);
  });
});

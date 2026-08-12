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
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
    search?: unknown;
  }) => {
    linkSearch.set(to, search);
    return (
      <a
        href={to}
        className={className}
        onClick={(e) => {
          e.preventDefault();
          linkClicks.push({ to });
        }}
      >
        {children}
      </a>
    );
  },
}));

// The stored reporting timezone. The real hook is a useQuery and would throw
// without a provider; `value: undefined` reproduces the in-flight window.
const timezoneState = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => timezoneState.value,
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
  timezoneState.value = 'Europe/Berlin';
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

  it('renders the Performance link after Calculator and before Accounts', () => {
    const { container, root } = mountWith(<Sidebar />);

    const hrefs = Array.from(container.querySelectorAll('nav a')).map((a) =>
      a.getAttribute('href'),
    );
    const calcIdx = hrefs.indexOf('/calculator');
    const perfIdx = hrefs.indexOf('/performance');
    const acctIdx = hrefs.indexOf('/accounts');

    expect(calcIdx).toBeGreaterThanOrEqual(0);
    expect(perfIdx).toBe(calcIdx + 1);
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
// The default performance window is anchored at the user's STORED reporting
// timezone, never at the browser's: a per-device guess would hand the same user
// a different window — and different figures inside it — on every machine.
// ---------------------------------------------------------------------------

describe('Sidebar — Performance defaults anchor at the stored timezone', () => {
  it('seeds the search params with the stored zone', () => {
    timezoneState.value = 'Asia/Tokyo';
    const { container, root } = mountWith(<Sidebar />);

    const search = linkSearch.get('/performance');
    expect(typeof search).toBe('function');
    const params = (
      search as () => { granularity: string; start: string; end: string; tz: string }
    )();

    expect(params.tz).toBe('Asia/Tokyo');
    // The rest of the monthly preset still comes through unchanged.
    expect(params.granularity).toBe('month');
    expect(params.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(params.end).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    unmount(container, root);
  });

  it('derives a different window for a different stored zone', () => {
    timezoneState.value = 'Pacific/Kiritimati';
    const first = mountWith(<Sidebar />);
    const kiritimati = (linkSearch.get('/performance') as () => { start: string })();
    unmount(first.container, first.root);

    timezoneState.value = 'Pacific/Midway';
    const second = mountWith(<Sidebar />);
    const midway = (linkSearch.get('/performance') as () => { start: string })();
    unmount(second.container, second.root);

    // +14 vs -11 puts the month boundaries on different UTC instants — proof
    // the zone actually reaches `derivePresetRange` rather than being ignored.
    expect(kiritimati.start).not.toBe(midway.start);
  });

  it('renders an inert Performance item while the stored zone is in flight', () => {
    timezoneState.value = undefined;
    const { container, root } = mountWith(<Sidebar />);

    // No destination exists yet, so there must be no navigable link…
    const performanceLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/performance',
    );
    expect(performanceLink).toBeUndefined();
    expect(linkSearch.has('/performance')).toBe(false);

    // …but the nav item stays in place so the rail does not reflow.
    const inert = container.querySelector('nav span[aria-disabled="true"]');
    expect(inert).not.toBeNull();
    expect(inert?.textContent).toContain('Performance');

    // The inert state has to be perceivable and reachable, not just visually
    // dimmed: `aria-disabled` on a role-less span is announced to nobody, and
    // with no tab stop a keyboard user skips the item without learning it
    // exists.
    expect(inert?.getAttribute('role')).toBe('link');
    expect(inert?.getAttribute('tabindex')).toBe('0');

    unmount(container, root);
  });
});

describe('Sidebar — Changelog link + new-updates badge', () => {
  it('renders the Changelog link before Settings, with cursor-pointer', () => {
    const { container, root } = mountWith(<Sidebar />);

    const hrefs = Array.from(container.querySelectorAll('nav a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs.indexOf('/changelog')).toBeGreaterThanOrEqual(0);
    // Ordering, not adjacency — which is what this test's name has always
    // claimed. The Docs link now sits between the two, and pinning `+ 1` would
    // make every future nav insertion look like a regression in the changelog.
    expect(hrefs.indexOf('/settings')).toBeGreaterThan(hrefs.indexOf('/changelog'));

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
    expect(logout?.parentElement?.className).toContain('shrink-0');

    unmount(container, root);
  });
});

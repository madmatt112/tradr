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
  ),
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
  localStorage.clear();
  changelogState.result = { data: undefined, isError: false };
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

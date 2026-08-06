// @vitest-environment jsdom
//
// There were previously ZERO links from this app to the documentation, so a user
// who needed an explanation had to already know the site existed. These assert
// the way in stays present, and stays an external link — the docs are on their
// own host, so a router <Link> would 404 inside the SPA.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'someone@example.com', isAdmin: false } }),
}));

vi.mock('@/features/changelog/hooks/useChangelog', () => ({
  useChangelogReleases: () => ({ data: undefined }),
  hasNewReleases: () => false,
}));

vi.mock('@/components/layout/ThemeToggle', () => ({ ThemeToggle: () => null }));

// The stored reporting timezone (user-onboarding R2.4) is a useQuery; stub it
// so the sidebar mounts standalone.
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => 'America/New_York',
}));

import { DOCS_BASE_URL, docsUrl } from '@/lib/docs';

import { Sidebar } from './Sidebar';

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

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar — documentation link', () => {
  it('links out to the documentation host', () => {
    const { container, root } = mountWith(<Sidebar />);

    const link = Array.from(container.querySelectorAll('nav a')).find((a) =>
      a.getAttribute('href')?.startsWith(DOCS_BASE_URL),
    );

    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe(docsUrl('home'));
    expect(link?.textContent).toContain('Docs');

    unmount(container, root);
  });

  it('opens in a new tab, with rel=noreferrer', () => {
    const { container, root } = mountWith(<Sidebar />);

    const link = Array.from(container.querySelectorAll('nav a')).find((a) =>
      a.getAttribute('href')?.startsWith(DOCS_BASE_URL),
    );

    // The reader is mid-task; replacing the app loses their place.
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noreferrer');

    unmount(container, root);
  });

  it('is styled as a pointer target, like every other button-like element', () => {
    const { container, root } = mountWith(<Sidebar />);

    const link = Array.from(container.querySelectorAll('nav a')).find((a) =>
      a.getAttribute('href')?.startsWith(DOCS_BASE_URL),
    );

    expect(link?.className).toContain('cursor-pointer');

    unmount(container, root);
  });
});

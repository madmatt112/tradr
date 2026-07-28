// @vitest-environment jsdom
// ChangelogPage states (REQ-4.5) + the mark-viewed trigger contract
// (REQ-5(a)(3)): fires exactly once on data (ref-guarded, StrictMode-proof),
// never on loading/error. The hooks module is mocked — no QueryClientProvider,
// no network (design Component 11).
import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangelogReleasesResponse } from '@tradr/shared';

import { ChangelogPage } from './ChangelogPage';

interface MockQueryState {
  data: ChangelogReleasesResponse | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

const { markViewed, queryState } = vi.hoisted(() => ({
  markViewed: vi.fn(),
  queryState: {
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
  } as MockQueryState,
}));

vi.mock('../hooks/useChangelog', () => ({
  useChangelogReleases: () => queryState,
  useMarkChangelogViewed: () => ({ mutate: markViewed }),
}));

function makeResponse(
  overrides: Partial<ChangelogReleasesResponse> = {},
): ChangelogReleasesResponse {
  return {
    releases: [
      {
        id: '2',
        name: 'v1.1.0',
        tag: 'v1.1.0',
        publishedAt: '2026-06-01T12:00:00.000Z',
        body: 'Newer release.',
        htmlUrl: 'https://github.com/madmatt112/tradr/releases/tag/v1.1.0',
        prerelease: false,
      },
      {
        id: '1',
        name: 'v1.0.0',
        tag: 'v1.0.0',
        publishedAt: '2026-05-01T12:00:00.000Z',
        body: 'Older release.',
        htmlUrl: 'https://github.com/madmatt112/tradr/releases/tag/v1.0.0',
        prerelease: false,
      },
    ],
    fetchedAt: '2026-06-10T00:00:00.000Z',
    stale: false,
    lastViewedAt: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

function setState(state: Partial<MockQueryState>) {
  Object.assign(
    queryState,
    { data: undefined, isPending: false, isError: false, error: null },
    state,
  );
}

beforeEach(() => {
  markViewed.mockReset();
  setState({ isPending: true });
});

afterEach(cleanup);

describe('ChangelogPage states', () => {
  it('loading: renders skeleton rows and no releases', () => {
    setState({ isPending: true });
    const { container } = render(<ChangelogPage />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Changelog');
  });

  it('success + empty: renders the "No releases yet" empty state', () => {
    setState({ data: makeResponse({ releases: [] }) });
    const { container } = render(<ChangelogPage />);

    expect(container.textContent).toContain('No releases yet');
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it('unavailable (CHANGELOG_UNAVAILABLE coded envelope): non-alarming message in the standard layout', () => {
    setState({
      isError: true,
      error: {
        status: 503,
        error: { code: 'CHANGELOG_UNAVAILABLE', message: 'Release notes unavailable' },
      },
    });
    const { container } = render(<ChangelogPage />);

    expect(container.textContent).toContain('Changelog');
    expect(container.textContent).toContain('Release notes are temporarily unavailable');
  });

  it('generic error: same non-alarming unavailable state', () => {
    setState({ isError: true, error: new Error('network down') });
    const { container } = render(<ChangelogPage />);

    expect(container.textContent).toContain('Release notes are temporarily unavailable');
  });

  it('success + stale: quiet one-line notice above the release list', () => {
    setState({ data: makeResponse({ stale: true }) });
    const { container } = render(<ChangelogPage />);

    expect(container.textContent).toContain('Showing previously fetched release notes');
    expect(container.textContent).toContain('v1.1.0');
    expect(container.textContent).toContain('v1.0.0');
  });

  it('success + fresh: no stale notice; releases render in server order (no re-sort)', () => {
    setState({ data: makeResponse() });
    const { container } = render(<ChangelogPage />);

    expect(container.textContent).not.toContain('Showing previously fetched release notes');
    const text = container.textContent ?? '';
    expect(text.indexOf('v1.1.0')).toBeGreaterThan(-1);
    expect(text.indexOf('v1.1.0')).toBeLessThan(text.indexOf('v1.0.0'));
  });
});

describe('mark-viewed trigger (REQ-5(a)(3))', () => {
  it('fires exactly once on data, surviving StrictMode double-effects and re-renders', () => {
    setState({ data: makeResponse() });
    const { rerender } = render(
      <StrictMode>
        <ChangelogPage />
      </StrictMode>,
    );

    // StrictMode re-runs the effect on mount; the ref guard absorbs it.
    expect(markViewed).toHaveBeenCalledTimes(1);

    rerender(
      <StrictMode>
        <ChangelogPage />
      </StrictMode>,
    );
    expect(markViewed).toHaveBeenCalledTimes(1);
  });

  it('fires on stale data — the user saw what was served', () => {
    setState({ data: makeResponse({ stale: true }) });
    render(<ChangelogPage />);

    expect(markViewed).toHaveBeenCalledTimes(1);
  });

  it('does not fire while loading', () => {
    setState({ isPending: true });
    render(<ChangelogPage />);

    expect(markViewed).not.toHaveBeenCalled();
  });

  it('does not fire when the query errors (unavailable visit must not advance the floor)', () => {
    setState({
      isError: true,
      error: { status: 503, error: { code: 'CHANGELOG_UNAVAILABLE', message: 'unavailable' } },
    });
    render(<ChangelogPage />);

    expect(markViewed).not.toHaveBeenCalled();
  });

  it('fires once it has data after a loading render', () => {
    setState({ isPending: true });
    const { rerender } = render(<ChangelogPage />);
    expect(markViewed).not.toHaveBeenCalled();

    setState({ data: makeResponse() });
    rerender(<ChangelogPage />);
    expect(markViewed).toHaveBeenCalledTimes(1);
  });
});

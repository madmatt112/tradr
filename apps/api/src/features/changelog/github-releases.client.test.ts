// Unit tests for the GitHub releases client (design Component 3,
// REQ-1.2–1.8, REQ-2.7). Injected fetchImpl — UW-client test precedent
// (unusual-whales.client.test.ts).

import { describe, expect, it, vi } from 'vitest';

import { config } from '@/lib/config';

import { GithubFetchError, fetchReleases } from './github-releases.client';

const STUB_BASE = 'https://stub.github.test';
const REPO = 'owner/repo';

/** A fetch mock returning a fixed Response; records the calls it received. */
function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init ?? {})),
  ) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A fully-populated upstream release; override per test. */
function ghRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tag_name: 'v1.0.0',
    name: 'Release 1.0.0',
    body: 'Notes',
    published_at: '2026-01-02T03:04:05Z',
    created_at: '2026-01-01T00:00:00Z',
    html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0',
    prerelease: false,
    ...overrides,
  };
}

function calls(fetchImpl: typeof fetch) {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

describe('fetchReleases — request shape (REQ-1.2)', () => {
  it('GETs ${base}/repos/${repo}/releases?per_page=20 with the pinned headers and NO auth', async () => {
    const fetchImpl = mockFetch(() => jsonResponse([]));

    await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    const [url, init] = calls(fetchImpl)[0];
    expect(url).toBe(`${STUB_BASE}/repos/${REPO}/releases?per_page=20`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.accept).toBe('application/vnd.github+json');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
    expect(headers['user-agent']).toBe('tradr-api');
    // No authorization header EVER (unauthenticated-only scope).
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('strips a trailing slash from baseUrl (UW precedent)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse([]));

    await fetchReleases({ fetchImpl, baseUrl: `${STUB_BASE}/`, repo: REPO });

    const [url] = calls(fetchImpl)[0];
    expect(url).toBe(`${STUB_BASE}/repos/${REPO}/releases?per_page=20`);
  });

  it('defaults baseUrl and repo from config when not injected', async () => {
    const fetchImpl = mockFetch(() => jsonResponse([]));

    await fetchReleases({ fetchImpl });

    const [url] = calls(fetchImpl)[0];
    expect(url).toBe(
      `${config.CHANGELOG_GITHUB_BASE_URL}/repos/${config.CHANGELOG_GITHUB_REPO}/releases?per_page=20`,
    );
  });
});

describe('fetchReleases — normalization (REQ-1.3)', () => {
  it('normalizes null name/body and string id', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse([ghRelease({ id: 42, name: null, body: null })]),
    );

    const [release] = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    expect(release.id).toBe('42');
    expect(release.name).toBe('v1.0.0'); // null name → tag fallback
    expect(release.body).toBe('');
    expect(release.tag).toBe('v1.0.0');
  });

  it('falls back to the tag for an EMPTY (not just null) name', async () => {
    const fetchImpl = mockFetch(() => jsonResponse([ghRelease({ name: '' })]));

    const [release] = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    expect(release.name).toBe('v1.0.0');
  });

  it('tolerates absent (undefined) name/body keys', async () => {
    const raw = ghRelease();
    delete raw.name;
    delete raw.body;
    const fetchImpl = mockFetch(() => jsonResponse([raw]));

    const [release] = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    expect(release.name).toBe('v1.0.0');
    expect(release.body).toBe('');
  });

  it('falls back to created_at when published_at is null (never excludes the entry)', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse([ghRelease({ published_at: null, created_at: '2026-02-03T04:05:06Z' })]),
    );

    const releases = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    expect(releases).toHaveLength(1);
    expect(releases[0].publishedAt).toBe('2026-02-03T04:05:06.000Z');
  });

  it('canonicalizes GitHub seconds-precision timestamps to millisecond-precision ISO', async () => {
    // Load-bearing for the badge predicate's lexicographic comparison
    // (Component 8): every contract timestamp must share one fixed shape.
    const fetchImpl = mockFetch(() =>
      jsonResponse([ghRelease({ published_at: '2026-01-02T03:04:05Z' })]),
    );

    const [release] = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    expect(release.publishedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(release.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('passes prerelease and htmlUrl through', async () => {
    const fetchImpl = mockFetch(() => jsonResponse([ghRelease({ prerelease: true })]));

    const [release] = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    expect(release.prerelease).toBe(true);
    expect(release.htmlUrl).toBe('https://github.com/owner/repo/releases/tag/v1.0.0');
  });
});

describe('fetchReleases — sort + bound (REQ-1.4/1.5)', () => {
  it('sorts descending by the EFFECTIVE publishedAt (created_at fallback participates)', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse([
        ghRelease({ id: 1, published_at: '2026-01-01T00:00:00Z' }),
        ghRelease({ id: 2, published_at: '2026-03-01T00:00:00Z' }),
        // null published_at → effective timestamp is created_at (newest of all).
        ghRelease({ id: 3, published_at: null, created_at: '2026-04-01T00:00:00Z' }),
        ghRelease({ id: 4, published_at: '2026-02-01T00:00:00Z' }),
      ]),
    );

    const releases = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    expect(releases.map((r) => r.id)).toEqual(['3', '2', '4', '1']);
  });

  it('bounds the result to 20 entries', async () => {
    const raw = Array.from({ length: 25 }, (_, i) =>
      ghRelease({
        id: i + 1,
        published_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    );
    const fetchImpl = mockFetch(() => jsonResponse(raw));

    const releases = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO });

    expect(releases).toHaveLength(20);
    expect(releases[0].id).toBe('25'); // newest survives the slice
    expect(releases[19].id).toBe('6'); // oldest 5 dropped
  });

  it('resolves an empty repo ([]) to [] — a success (REQ-1.7)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse([]));

    await expect(fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO })).resolves.toEqual([]);
  });
});

describe('fetchReleases — failure mapping (REQ-2.4/2.5/2.7, no-leak discipline)', () => {
  it('aborts via the 10 s timeout → GithubFetchError', async () => {
    vi.useFakeTimers();
    try {
      // A fetch that rejects only when its own signal aborts (real fetch behavior).
      const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }) as unknown as typeof fetch;

      const promise = fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      const err = await promise;

      expect(err).toBeInstanceOf(GithubFetchError);
      expect((err as Error).message).not.toContain('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a network failure → GithubFetchError without leaking the cause', async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError('network down');
    });

    const err = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO }).catch((e) => e);

    expect(err).toBeInstanceOf(GithubFetchError);
    expect((err as Error).message).not.toContain('network down');
  });

  for (const status of [403, 404, 429, 500]) {
    it(`maps HTTP ${status} → GithubFetchError without leaking the upstream body`, async () => {
      const fetchImpl = mockFetch(() => new Response('secret upstream detail', { status }));

      const err = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO }).catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(GithubFetchError);
      expect((err as Error).message).not.toContain('secret upstream detail');
      expect((err as Error).message).not.toContain(String(status));
    });
  }

  it('maps a 2xx with unreadable JSON → GithubFetchError', async () => {
    const fetchImpl = mockFetch(() => new Response('not json {', { status: 200 }));

    const err = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO }).catch((e) => e);

    expect(err).toBeInstanceOf(GithubFetchError);
    expect((err as Error).message).not.toContain('not json');
  });

  it('maps a 2xx that fails Zod (non-array) → GithubFetchError', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ message: 'unexpected envelope' }));

    const err = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO }).catch((e) => e);

    expect(err).toBeInstanceOf(GithubFetchError);
    expect((err as Error).message).not.toContain('unexpected envelope');
  });

  it('fails Zod on a garbage-but-string timestamp (never a RangeError escape)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse([ghRelease({ published_at: 'not-a-date' })]));

    const err = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO }).catch((e) => e);

    expect(err).toBeInstanceOf(GithubFetchError);
    expect((err as Error).message).not.toContain('not-a-date');
  });

  it('fails Zod on a non-https html_url (javascript: scheme)', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse([ghRelease({ html_url: 'javascript:alert(1)' })]),
    );

    const err = await fetchReleases({ fetchImpl, baseUrl: STUB_BASE, repo: REPO }).catch((e) => e);

    expect(err).toBeInstanceOf(GithubFetchError);
    expect((err as Error).message).not.toContain('javascript:');
  });
});

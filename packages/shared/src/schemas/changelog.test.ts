import { describe, expect, it } from 'vitest';

import {
  ChangelogReleaseSchema,
  ChangelogReleasesResponseSchema,
  MarkChangelogViewedResponseSchema,
} from './changelog';

const validRelease = {
  id: '123456789',
  name: 'v1.2.0 — Performance dashboard',
  tag: 'v1.2.0',
  publishedAt: '2026-05-01T12:00:00Z',
  body: '## Highlights\n\n- Faster equity curve',
  htmlUrl: 'https://github.com/acme/tradr/releases/tag/v1.2.0',
  prerelease: false,
};

describe('ChangelogReleaseSchema', () => {
  it('accepts a valid release', () => {
    expect(ChangelogReleaseSchema.safeParse(validRelease).success).toBe(true);
  });

  it('rejects a numeric id', () => {
    expect(ChangelogReleaseSchema.safeParse({ ...validRelease, id: 123456789 }).success).toBe(
      false,
    );
  });

  it('rejects a non-datetime publishedAt', () => {
    expect(
      ChangelogReleaseSchema.safeParse({ ...validRelease, publishedAt: 'yesterday' }).success,
    ).toBe(false);
  });

  it('rejects a missing body', () => {
    const rest: Record<string, unknown> = { ...validRelease };
    delete rest.body;
    expect(ChangelogReleaseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-boolean prerelease', () => {
    expect(ChangelogReleaseSchema.safeParse({ ...validRelease, prerelease: 'no' }).success).toBe(
      false,
    );
  });

  describe('htmlUrl scheme refine', () => {
    it('accepts https://github.com/...', () => {
      expect(
        ChangelogReleaseSchema.safeParse({
          ...validRelease,
          htmlUrl: 'https://github.com/acme/tradr/releases/tag/v1.0.0',
        }).success,
      ).toBe(true);
    });

    it('rejects javascript:alert(1)', () => {
      expect(
        ChangelogReleaseSchema.safeParse({ ...validRelease, htmlUrl: 'javascript:alert(1)' })
          .success,
      ).toBe(false);
    });

    it('rejects http://github.com/... (non-https scheme)', () => {
      expect(
        ChangelogReleaseSchema.safeParse({
          ...validRelease,
          htmlUrl: 'http://github.com/acme/tradr/releases/tag/v1.0.0',
        }).success,
      ).toBe(false);
    });

    it('rejects a non-URL string', () => {
      expect(
        ChangelogReleaseSchema.safeParse({ ...validRelease, htmlUrl: 'not a url' }).success,
      ).toBe(false);
    });
  });
});

describe('ChangelogReleasesResponseSchema', () => {
  const validResponse = {
    releases: [validRelease],
    fetchedAt: '2026-05-02T08:30:00Z',
    stale: false,
    lastViewedAt: '2026-04-30T00:00:00Z',
  };

  it('accepts a valid envelope', () => {
    expect(ChangelogReleasesResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it('accepts an empty releases array', () => {
    expect(
      ChangelogReleasesResponseSchema.safeParse({ ...validResponse, releases: [] }).success,
    ).toBe(true);
  });

  it('rejects an invalid release inside the array', () => {
    expect(
      ChangelogReleasesResponseSchema.safeParse({
        ...validResponse,
        releases: [{ ...validRelease, htmlUrl: 'javascript:alert(1)' }],
      }).success,
    ).toBe(false);
  });

  it('rejects null lastViewedAt (never nullable)', () => {
    expect(
      ChangelogReleasesResponseSchema.safeParse({ ...validResponse, lastViewedAt: null }).success,
    ).toBe(false);
  });

  it('rejects absent lastViewedAt', () => {
    const rest: Record<string, unknown> = { ...validResponse };
    delete rest.lastViewedAt;
    expect(ChangelogReleasesResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-datetime fetchedAt', () => {
    expect(
      ChangelogReleasesResponseSchema.safeParse({ ...validResponse, fetchedAt: '2026-05-02' })
        .success,
    ).toBe(false);
  });

  it('rejects a non-boolean stale', () => {
    expect(
      ChangelogReleasesResponseSchema.safeParse({ ...validResponse, stale: 'false' }).success,
    ).toBe(false);
  });
});

describe('MarkChangelogViewedResponseSchema', () => {
  it('accepts a valid payload', () => {
    expect(
      MarkChangelogViewedResponseSchema.safeParse({ lastViewedAt: '2026-05-02T08:30:00Z' }).success,
    ).toBe(true);
  });

  it('rejects null lastViewedAt', () => {
    expect(MarkChangelogViewedResponseSchema.safeParse({ lastViewedAt: null }).success).toBe(false);
  });

  it('rejects an empty object', () => {
    expect(MarkChangelogViewedResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-datetime lastViewedAt', () => {
    expect(MarkChangelogViewedResponseSchema.safeParse({ lastViewedAt: 'now' }).success).toBe(
      false,
    );
  });
});

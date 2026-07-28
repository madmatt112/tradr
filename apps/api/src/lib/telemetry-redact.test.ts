import { describe, expect, it } from 'vitest';

import { scrubDeep, scrubString } from './telemetry-redact';

describe('scrubString', () => {
  it('masks OpenAI/Anthropic hyphen-form API keys', () => {
    expect(scrubString('key=sk-abcDEF0123456789')).toBe('key=[redacted]');
    expect(scrubString('key=sk-ant-api03-AbC_123-xyz')).toBe('key=[redacted]');
    expect(scrubString('key=sk-proj-AbC123xyz')).toBe('key=[redacted]');
  });

  it('masks Stripe underscore-form keys', () => {
    expect(scrubString('sk_live_abc123DEF')).toBe('[redacted]');
    expect(scrubString('rk_test_abc123')).toBe('[redacted]');
    expect(scrubString('whsec_abcDEF123')).toBe('[redacted]');
  });

  it('masks PostHog keys', () => {
    expect(scrubString('phc_abc123XYZ')).toBe('[redacted]');
    expect(scrubString('phx_abc123XYZ')).toBe('[redacted]');
  });

  it('masks Bearer tokens', () => {
    expect(scrubString('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [redacted]');
  });

  it('masks JWTs', () => {
    expect(scrubString('token eyJhbGciOi.eyJzdWIiOi.SflKxwRJ-abc')).toBe('token [redacted]');
  });

  it('masks anchored email addresses', () => {
    expect(scrubString('contact john@example.com please')).toBe('contact [redacted] please');
    expect(scrubString('a.b+tag@sub.example.co.uk')).toBe('[redacted]');
  });

  it('masks uploaded image/doc filenames', () => {
    expect(scrubString('uploaded chart-2024.png')).toBe('uploaded [redacted]');
    expect(scrubString('file report.pdf')).toBe('file [redacted]');
    expect(scrubString('sheet data.xlsx')).toBe('sheet [redacted]');
    expect(scrubString('img photo.jpeg')).toBe('img [redacted]');
  });

  it('does NOT match pnpm scoped-package or store-path tokens in a stack frame', () => {
    const stack =
      'at handler (/app/node_modules/.pnpm/@hono+node-server@1.0.0/node_modules/@hono/node-server/dist/index.js:65:10)\n' +
      '    at run (/app/node_modules/.pnpm/postgres@3.4.4/node_modules/postgres/cjs/src/index.js:120:7)';
    // No '@scope/pkg' or 'pkg@version/...' token should be masked, and the
    // '.js:line:col' frames must survive (no filename rule, no email rule fires).
    expect(scrubString(stack)).toBe(stack);
    expect(scrubString(stack)).not.toContain('[redacted]');
  });

  it('does NOT redact a 64-hex SHA-256 fingerprint', () => {
    const fingerprint = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    expect(scrubString(fingerprint)).toBe(fingerprint);
  });
});

describe('scrubDeep — key denylist', () => {
  const denyKeys = [
    'password',
    'token',
    'apiKey',
    'api_key',
    'secret',
    'authorization',
    'cookie',
    'sessionToken',
    'session',
    'encryptionKey',
    'refreshToken',
    'accessToken',
    'clientSecret',
    'email',
  ];

  it('masks each denylisted key at the top level', () => {
    for (const key of denyKeys) {
      expect(scrubDeep({ [key]: 'whatever' })).toEqual({ [key]: '[redacted]' });
    }
  });

  it('masks denylisted keys case-insensitively', () => {
    expect(scrubDeep({ APIKEY: 'x', Authorization: 'y', EMAIL: 'z' })).toEqual({
      APIKEY: '[redacted]',
      Authorization: '[redacted]',
      EMAIL: '[redacted]',
    });
  });

  it('masks denylisted keys when nested (closes the shallow-bypass hole)', () => {
    expect(scrubDeep({ ctx: { apiKey: 'sk-ant-api03-secret' } })).toEqual({
      ctx: { apiKey: '[redacted]' },
    });
  });
});

describe('scrubDeep — value scrubbing', () => {
  it('scrubs secret/email/filename patterns inside string values', () => {
    expect(
      scrubDeep({
        note: 'reach me at john@example.com',
        attachment: 'chart.png',
        msg: 'used sk-proj-abc123',
      }),
    ).toEqual({
      note: 'reach me at [redacted]',
      attachment: '[redacted]',
      msg: 'used [redacted]',
    });
  });

  it('leaves Date/number/boolean/null/undefined untouched and never throws', () => {
    const date = new Date('2026-06-16T00:00:00.000Z');
    const result = scrubDeep({
      when: date,
      count: 42,
      flag: true,
      nothing: null,
      missing: undefined,
    }) as Record<string, unknown>;
    expect(result.when).toBe(date);
    expect(result.count).toBe(42);
    expect(result.flag).toBe(true);
    expect(result.nothing).toBeNull();
    expect(result.missing).toBeUndefined();
  });

  it('returns primitives and Date passed directly without throwing', () => {
    const date = new Date();
    expect(scrubDeep(42)).toBe(42);
    expect(scrubDeep(true)).toBe(true);
    expect(scrubDeep(null)).toBeNull();
    expect(scrubDeep(undefined)).toBeUndefined();
    expect(scrubDeep(date)).toBe(date);
  });

  it('fully traverses objects within arrays within objects', () => {
    expect(
      scrubDeep({
        items: [{ password: 'p1' }, { meta: { token: 't', email: 'a@b.com', ok: 1 } }],
      }),
    ).toEqual({
      items: [
        { password: '[redacted]' },
        { meta: { token: '[redacted]', email: '[redacted]', ok: 1 } },
      ],
    });
  });
});

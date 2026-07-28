import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the two production cookie surfaces' policy (hosted-platform
// Task 14, REQ-5.2/5.4/5.5/1.2). Config is mocked per the billing/feature-gate
// pattern so isSplitOriginConfigured + NODE_ENV can be driven per-test.

const mocks = vi.hoisted(() => ({
  isSplitOriginConfigured: vi.fn(),
  config: { NODE_ENV: 'development' as 'development' | 'production' | 'test' },
}));

vi.mock('@/lib/config', () => ({
  config: mocks.config,
  isSplitOriginConfigured: mocks.isSplitOriginConfigured,
}));

import { sessionCookieOptions, themeCookieAttributes } from '@/lib/cookie-policy';

describe('cookie-policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.NODE_ENV = 'development';
    mocks.isSplitOriginConfigured.mockReturnValue(false);
  });

  describe('split-origin ON', () => {
    beforeEach(() => {
      mocks.isSplitOriginConfigured.mockReturnValue(true);
    });

    it('session cookie is SameSite=None; Secure; HttpOnly retained (REQ-5.2)', () => {
      expect(sessionCookieOptions()).toEqual({
        httpOnly: true,
        sameSite: 'None',
        path: '/',
        maxAge: 86400,
        secure: true,
      });
    });

    it('theme cookie is SameSite=None; Secure, no HttpOnly (REQ-5.4)', () => {
      const attrs = themeCookieAttributes();
      expect(attrs).toBe('Path=/; SameSite=None; Max-Age=31536000; Secure');
      expect(attrs).not.toContain('HttpOnly');
    });

    it('forces Secure regardless of NODE_ENV; never SameSite=None without Secure (REQ-5.5)', () => {
      mocks.config.NODE_ENV = 'development';
      expect(sessionCookieOptions().secure).toBe(true);
      expect(themeCookieAttributes()).toContain('Secure');
    });
  });

  describe('split-origin OFF — byte-identical to today (REQ-1.2)', () => {
    it('session cookie is SameSite=Lax; secure follows NODE_ENV (non-prod)', () => {
      mocks.config.NODE_ENV = 'development';
      expect(sessionCookieOptions()).toEqual({
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 86400,
        secure: false,
      });
    });

    it('session cookie secure=true in production', () => {
      mocks.config.NODE_ENV = 'production';
      expect(sessionCookieOptions().secure).toBe(true);
      expect(sessionCookieOptions().sameSite).toBe('Lax');
    });

    it('theme cookie is SameSite=Lax, no Secure in non-prod', () => {
      mocks.config.NODE_ENV = 'development';
      expect(themeCookieAttributes()).toBe('Path=/; SameSite=Lax; Max-Age=31536000');
    });

    it('theme cookie appends Secure in production', () => {
      mocks.config.NODE_ENV = 'production';
      expect(themeCookieAttributes()).toBe('Path=/; SameSite=Lax; Max-Age=31536000; Secure');
    });
  });
});

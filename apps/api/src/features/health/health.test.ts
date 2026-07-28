import { describe, it, expect, vi } from 'vitest';

import app from '@/app';

describe('health check', () => {
  it('returns 200 with status ok (no version field when APP_VERSION unset)', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('reports the deployed version when APP_VERSION is set', async () => {
    // Config is frozen at module load; re-import the app graph with the env
    // set (same recipe as migrate.test.ts).
    process.env.APP_VERSION = 'v9.9.9-abc1234';
    vi.resetModules();
    try {
      const { default: freshApp } = await import('@/app');
      const res = await freshApp.request('/api/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', version: 'v9.9.9-abc1234' });
    } finally {
      delete process.env.APP_VERSION;
      vi.resetModules();
    }
  });
});

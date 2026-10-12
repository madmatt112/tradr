import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { config } from '@/lib/config';

// GET /api/billing/config reports each priced model's `vision` flag from the
// provider's own model list, read with the platform key. The registry is
// mocked so no provider is called over the network.
const listModels = vi.fn();
vi.mock('@/features/advisor/providers/registry', () => ({
  getProvider: () => ({ listModels }),
  initProviderRegistry: vi.fn(),
}));

const prevAnthropicKey = config.ANTHROPIC_API_KEY;
afterEach(() => {
  config.ANTHROPIC_API_KEY = prevAnthropicKey;
  listModels.mockReset();
});

let counter = 0;
function uniqueIp() {
  return `10.89.${Math.floor(++counter / 256)}.${counter % 256}`;
}

async function registerAndGetCookie(): Promise<string> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({
      email: `billing-vision-${Date.now()}-${counter}@example.com`,
      password: 'password123',
    }),
  });
  expect(res.status).toBe(201);
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(/session=([^;]*)/);
    if (match) return match[1];
  }
  throw new Error('no session cookie');
}

async function claudeModels(cookie: string) {
  const res = await app.request('/api/billing/config', {
    headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return (body.models as { providerId: string; model: string; vision?: boolean }[]).filter(
    (m) => m.providerId === 'claude',
  );
}

describe('GET /api/billing/config — model vision flag', () => {
  it("copies each priced model's vision flag from the provider's model list", async () => {
    const cookie = await registerAndGetCookie();
    config.ANTHROPIC_API_KEY = 'sk-ant-test-dummy';
    listModels.mockResolvedValue([
      { id: 'claude-sonnet-4-5', displayName: 's', contextWindow: 1, vision: true, toolUse: true },
      { id: 'claude-haiku-3-5', displayName: 'h', contextWindow: 1, vision: false, toolUse: true },
    ]);

    const models = await claudeModels(cookie);
    expect(models.find((m) => m.model === 'claude-sonnet-4-5')?.vision).toBe(true);
    expect(models.find((m) => m.model === 'claude-haiku-3-5')?.vision).toBe(false);
    // A priced model the provider does not list is not assumed to see images.
    expect(models.find((m) => m.model === 'claude-opus-4-7')?.vision).toBe(false);
  });

  it('reports vision false for every model when the provider list cannot be read', async () => {
    const cookie = await registerAndGetCookie();
    config.ANTHROPIC_API_KEY = 'sk-ant-test-dummy';
    listModels.mockRejectedValue(new Error('upstream down'));

    const models = await claudeModels(cookie);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(m.vision).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock state shared between the vi.mock factories and the tests. Kept
// stable across vi.resetModules() so re-importing posthog.ts (to get a fresh
// module-level singleton per test) still sees the same stubbed deps.
const h = vi.hoisted(() => {
  const capture = vi.fn();
  const identify = vi.fn();
  const captureException = vi.fn();
  const shutdown = vi.fn(() => Promise.resolve());
  const PostHogCtor = vi.fn(() => ({ capture, identify, captureException, shutdown }));
  const isPostHogConfigured = vi.fn();
  const logTelemetryFailureOnce = vi.fn();
  const config = { POSTHOG_API_KEY: 'phc_test123', POSTHOG_HOST: 'https://us.i.posthog.com' };
  return {
    capture,
    identify,
    captureException,
    shutdown,
    PostHogCtor,
    isPostHogConfigured,
    logTelemetryFailureOnce,
    config,
  };
});

vi.mock('posthog-node', () => ({ PostHog: h.PostHogCtor }));
vi.mock('./config', () => ({ config: h.config, isPostHogConfigured: h.isPostHogConfigured }));
vi.mock('./telemetry-failure', () => ({ logTelemetryFailureOnce: h.logTelemetryFailureOnce }));
// telemetry-redact is intentionally NOT mocked — the REAL scrubDeep runs so the
// capture-boundary value-scrub (REQ-8.5) is exercised end to end.

// Fresh posthog.ts (and its `client` singleton) per test, with the mocks above.
async function load() {
  vi.resetModules();
  return import('./posthog');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('initPostHog', () => {
  it('unconfigured: constructs no client', async () => {
    h.isPostHogConfigured.mockReturnValue(false);
    const { initPostHog } = await load();

    initPostHog();

    expect(h.PostHogCtor).not.toHaveBeenCalled();
  });

  it('configured: constructs the client with key + host and batching options', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog } = await load();

    initPostHog();

    expect(h.PostHogCtor).toHaveBeenCalledTimes(1);
    expect(h.PostHogCtor).toHaveBeenCalledWith('phc_test123', {
      host: 'https://us.i.posthog.com',
      flushAt: 20,
      flushInterval: 10_000,
    });
  });
});

describe('captureServerEvent', () => {
  it('uninitialized (no client): is a no-op', async () => {
    h.isPostHogConfigured.mockReturnValue(false);
    const { captureServerEvent } = await load();

    // initPostHog() not run -> client stays null.
    captureServerEvent('position_created', { distinctId: 'user-1' });

    expect(h.capture).not.toHaveBeenCalled();
  });

  it('configured: captures with distinctId, event name, and scrubbed properties', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerEvent } = await load();

    initPostHog();
    captureServerEvent('position_created', {
      distinctId: 'user-uuid-1',
      properties: { assetType: 'stock' },
    });

    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture).toHaveBeenCalledWith({
      distinctId: 'user-uuid-1',
      event: 'position_created',
      properties: { assetType: 'stock' },
    });
  });

  it('defaults missing properties to an empty object', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerEvent } = await load();

    initPostHog();
    captureServerEvent('advisor_conversation_started', { distinctId: 'user-2' });

    expect(h.capture).toHaveBeenCalledWith({
      distinctId: 'user-2',
      event: 'advisor_conversation_started',
      properties: {},
    });
  });

  it('scrubs a secret/email accidentally passed in a property value (REQ-8.5)', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerEvent } = await load();

    initPostHog();
    captureServerEvent('position_created', {
      distinctId: 'user-3',
      properties: { note: 'contact john@example.com key sk-abc123def456' },
    });

    const props = h.capture.mock.calls[0][0].properties as Record<string, unknown>;
    expect(props.note).not.toContain('john@example.com');
    expect(props.note).not.toContain('sk-abc123def456');
    expect(props.note).toContain('[redacted]');
  });

  it('swallows a capture throw via logTelemetryFailureOnce (does not propagate)', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    h.capture.mockImplementation(() => {
      throw new Error('capture down');
    });
    const { initPostHog, captureServerEvent } = await load();

    initPostHog();

    expect(() => captureServerEvent('position_closed', { distinctId: 'user-4' })).not.toThrow();
    expect(h.logTelemetryFailureOnce).toHaveBeenCalledTimes(1);
    expect(h.logTelemetryFailureOnce).toHaveBeenCalledWith('posthog', expect.any(Error));
  });
});

describe('identifyServerUser', () => {
  it('uninitialized (no client): is a no-op', async () => {
    h.isPostHogConfigured.mockReturnValue(false);
    const { identifyServerUser } = await load();

    identifyServerUser('user-1', { email_verified: true });

    expect(h.identify).not.toHaveBeenCalled();
  });

  it('configured: sets person properties via $set', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, identifyServerUser } = await load();

    initPostHog();
    identifyServerUser('user-uuid-1', { email_verified: true });

    expect(h.identify).toHaveBeenCalledTimes(1);
    expect(h.identify).toHaveBeenCalledWith({
      distinctId: 'user-uuid-1',
      properties: { $set: { email_verified: true } },
    });
  });

  it('swallows an identify throw via logTelemetryFailureOnce (does not propagate)', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    h.identify.mockImplementation(() => {
      throw new Error('identify down');
    });
    const { initPostHog, identifyServerUser } = await load();

    initPostHog();

    expect(() => identifyServerUser('user-2', { email_verified: false })).not.toThrow();
    expect(h.logTelemetryFailureOnce).toHaveBeenCalledWith('posthog', expect.any(Error));
  });
});

describe('captureServerException', () => {
  it('uninitialized (no client): is a no-op', async () => {
    h.isPostHogConfigured.mockReturnValue(false);
    const { captureServerException } = await load();

    captureServerException(new Error('boom'), 'user-1');

    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('configured: forwards a REDACTED error (message + stack scrubbed) with distinctId', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerException } = await load();

    initPostHog();
    const err = new Error('failed for john@example.com with key sk-abc123def456');
    err.stack = 'Error: john@example.com phc_secretproj\n    at foo (/app/src/x.ts:10:5)';
    captureServerException(err, 'user-uuid-1');

    expect(h.captureException).toHaveBeenCalledTimes(1);
    const [sent, distinctId] = h.captureException.mock.calls[0];
    expect(distinctId).toBe('user-uuid-1');
    // Name preserved so PostHog error tracking still groups by type.
    expect((sent as Error).name).toBe('Error');
    // Email + vendor secret scrubbed from BOTH message and stack.
    expect((sent as Error).message).not.toContain('john@example.com');
    expect((sent as Error).message).not.toContain('sk-abc123def456');
    expect((sent as Error).message).toContain('[redacted]');
    expect((sent as Error).stack).not.toContain('john@example.com');
    expect((sent as Error).stack).not.toContain('phc_secretproj');
    // A real stack frame stays intact (redaction keeps file:line:col).
    expect((sent as Error).stack).toContain('/app/src/x.ts:10:5');
  });

  it('swallows a captureException throw via logTelemetryFailureOnce (does not propagate)', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    h.captureException.mockImplementation(() => {
      throw new Error('capture down');
    });
    const { initPostHog, captureServerException } = await load();

    initPostHog();

    expect(() => captureServerException(new Error('x'), 'user-3')).not.toThrow();
    expect(h.logTelemetryFailureOnce).toHaveBeenCalledWith('posthog', expect.any(Error));
  });
});

describe('shutdownPostHog', () => {
  it('resolves instantly and does not call shutdown when unconfigured', async () => {
    h.isPostHogConfigured.mockReturnValue(false);
    const { initPostHog, shutdownPostHog } = await load();

    initPostHog();

    await expect(shutdownPostHog()).resolves.toBeUndefined();
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it('calls client.shutdown() once when configured', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, shutdownPostHog } = await load();

    initPostHog();
    await shutdownPostHog();

    expect(h.shutdown).toHaveBeenCalledTimes(1);
  });

  it('swallows a shutdown rejection through logTelemetryFailureOnce (never throws)', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    h.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
    const { initPostHog, shutdownPostHog } = await load();

    initPostHog();

    await expect(shutdownPostHog()).resolves.toBeUndefined();
    expect(h.logTelemetryFailureOnce).toHaveBeenCalledWith('posthog', expect.any(Error));
  });
});

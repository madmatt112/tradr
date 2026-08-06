import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock state shared between the vi.mock factories and the tests. Kept
// stable across vi.resetModules() so re-importing posthog.ts (to get a fresh
// module-level singleton per test) still sees the same stubbed deps.
const h = vi.hoisted(() => {
  const capture = vi.fn();
  // Mirrors posthog-node's real identify(): it destructures
  // `{ $set, $set_once, $anon_distinct_id, ...rest }` and DISCARDS `rest`, so any
  // other top-level property never reaches PostHog. A permissive mock hid exactly
  // this — a top-level `environment` looked delivered in tests and was dropped in
  // production. The mock records what the SDK would actually send.
  const identifySent: Array<{ distinctId: string; properties: Record<string, unknown> }> = [];
  const identifyImpl = (msg: { distinctId: string; properties?: Record<string, unknown> }) => {
    const { $set, $set_once, $anon_distinct_id, ...rest } = msg.properties ?? {};
    identifySent.push({
      distinctId: msg.distinctId,
      properties: {
        // `$set || rest` is the SDK's own fallback: `rest` is used ONLY when no
        // $set was given, and is otherwise discarded entirely.
        $set: $set ?? rest,
        $set_once: $set_once ?? {},
        $anon_distinct_id: $anon_distinct_id ?? undefined,
      },
    });
  };
  const identify = vi.fn(identifyImpl);
  const captureException = vi.fn();
  const shutdown = vi.fn(() => Promise.resolve());
  const PostHogCtor = vi.fn(() => ({ capture, identify, captureException, shutdown }));
  const isPostHogConfigured = vi.fn();
  const logTelemetryFailureOnce = vi.fn();
  const config = {
    POSTHOG_API_KEY: 'phc_test123',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    // Unset by default — the self-host shape every other test asserts against.
    POSTHOG_ENVIRONMENT: undefined as string | undefined,
  };
  return {
    capture,
    identify,
    identifyImpl,
    identifySent,
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
  h.config.POSTHOG_ENVIRONMENT = undefined;
  h.identifySent.length = 0;
  // clearAllMocks() clears CALLS but keeps any mockImplementation a previous test
  // installed — the throw-path test would otherwise leave identify throwing for
  // the rest of the file, silently emptying identifySent.
  h.identify.mockImplementation(h.identifyImpl);
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
      properties: { assetType: 'stock', $geoip_disable: true },
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
      properties: { $geoip_disable: true },
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

describe('POSTHOG_ENVIRONMENT stamp', () => {
  it('unset: adds no environment property to a captured event (self-host default)', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerEvent } = await load();

    initPostHog();
    captureServerEvent('position_created', { distinctId: 'user-1' });

    const props = h.capture.mock.calls[0][0].properties as Record<string, unknown>;
    expect(props).not.toHaveProperty('environment');
  });

  it('set: stamps environment onto a captured event alongside scrubbed properties', async () => {
    h.config.POSTHOG_ENVIRONMENT = 'staging';
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerEvent } = await load();

    initPostHog();
    captureServerEvent('position_created', {
      distinctId: 'user-1',
      properties: { assetType: 'stock' },
    });

    expect(h.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'position_created',
      properties: { assetType: 'stock', environment: 'staging', $geoip_disable: true },
    });
  });

  it("set: the deploy's label wins over a caller-supplied environment property", async () => {
    h.config.POSTHOG_ENVIRONMENT = 'production';
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerEvent } = await load();

    initPostHog();
    captureServerEvent('position_created', {
      distinctId: 'user-1',
      properties: { environment: 'not-the-deploy-label' },
    });

    const props = h.capture.mock.calls[0][0].properties as Record<string, unknown>;
    expect(props.environment).toBe('production');
  });

  it('set: stamps environment onto person properties via $set', async () => {
    h.config.POSTHOG_ENVIRONMENT = 'staging';
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, identifyServerUser } = await load();

    initPostHog();
    identifyServerUser('user-1', { email_verified: true });

    expect(h.identify).toHaveBeenCalledWith({
      distinctId: 'user-1',
      properties: { $set: { email_verified: true, environment: 'staging' } },
    });
  });

  it('set: passes environment as captureException additional properties', async () => {
    h.config.POSTHOG_ENVIRONMENT = 'staging';
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerException } = await load();

    initPostHog();
    captureServerException(new Error('boom'), 'user-1');

    expect(h.captureException.mock.calls[0][2]).toEqual({
      environment: 'staging',
      $geoip_disable: true,
    });
  });

  it('unset: captureException still carries $geoip_disable, with no environment', async () => {
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerException } = await load();

    initPostHog();
    captureServerException(new Error('boom'), 'user-1');

    expect(h.captureException.mock.calls[0][2]).toEqual({ $geoip_disable: true });
  });
});

// Regression cover for two defects found by inspecting live ingested data rather
// than by any unit test: backend events were being geo-enriched from the
// container's egress IP, and `$identify` events carried no `environment` because
// the label was only ever written into the person `$set` bag.
describe('$geoip_disable (server-side geo suppression)', () => {
  it.each([
    ['unconfigured environment', undefined],
    ['configured environment', 'staging'],
  ])('is set on captured events — %s', async (_label, environment) => {
    h.config.POSTHOG_ENVIRONMENT = environment;
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, captureServerEvent } = await load();

    initPostHog();
    captureServerEvent('position_created', { distinctId: 'user-1' });

    const props = h.capture.mock.calls[0][0].properties as Record<string, unknown>;
    expect(props.$geoip_disable).toBe(true);
  });

  it('never leaks the ingestion directive into the person $set bag', async () => {
    h.config.POSTHOG_ENVIRONMENT = 'staging';
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, identifyServerUser } = await load();

    initPostHog();
    identifyServerUser('user-1', { email_verified: true });

    // An ingestion directive is not a user attribute.
    const sent = h.identifySent[0];
    expect(sent.properties.$set).not.toHaveProperty('$geoip_disable');
  });

  it('labels the person profile; the $identify event is unlabelled by SDK design', async () => {
    h.config.POSTHOG_ENVIRONMENT = 'staging';
    h.isPostHogConfigured.mockReturnValue(true);
    const { initPostHog, identifyServerUser } = await load();

    initPostHog();
    identifyServerUser('user-1', { email_verified: true });

    // Asserted against what posthog-node would ACTUALLY transmit: identify()
    // discards every top-level property except $set / $set_once /
    // $anon_distinct_id. An earlier version spread the label at the top level and
    // a permissive mock reported success while production events stayed
    // unlabelled — hence identifySent, which models the real stripping.
    const sent = h.identifySent[0];
    const set = sent.properties.$set as Record<string, unknown>;
    expect(set.environment).toBe('staging');
    // The event itself carries no label. Filter $identify by PERSON property.
    expect(sent.properties).not.toHaveProperty('environment');
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

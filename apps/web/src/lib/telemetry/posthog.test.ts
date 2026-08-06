// @vitest-environment jsdom
import type { AnyRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Vite's ?raw loader returns the module source as a string (cwd-independent).
// @ts-expect-error -- no ambient type for the ?raw query in this tsconfig
import posthogSource from './posthog.ts?raw';

// Stub the dynamically-imported posthog-js to a minimal init/capture surface.
// vi.mock is hoisted, so the spies are created with vi.hoisted.
const { initSpy, captureSpy, startExceptionAutocaptureSpy, captureExceptionSpy, registerSpy } =
  vi.hoisted(() => ({
    initSpy: vi.fn(),
    captureSpy: vi.fn(),
    startExceptionAutocaptureSpy: vi.fn(),
    captureExceptionSpy: vi.fn(),
    registerSpy: vi.fn(),
  }));

vi.mock('posthog-js', () => ({
  default: {
    init: initSpy,
    capture: captureSpy,
    startExceptionAutocapture: startExceptionAutocaptureSpy,
    captureException: captureExceptionSpy,
    register: registerSpy,
  },
}));

const PATTERN = '/_auth/positions/$positionId';

function makeStubRouter(matches: Array<{ routeId: string }>): AnyRouter {
  return {
    state: { matches },
    subscribe: () => () => {},
  } as unknown as AnyRouter;
}

// A stub router whose subscribe('onResolved', fn) records fn so a test can fire
// a simulated navigation. `matches` is mutable so the test can populate it after
// the async init (mirroring the router resolving its first route).
function makeFireableRouter(matches: Array<{ routeId: string }> = []): {
  router: AnyRouter;
  fireResolved: () => void;
} {
  const listeners: Array<() => void> = [];
  const router = {
    state: { matches },
    subscribe: (event: string, fn: () => void) => {
      if (event === 'onResolved') listeners.push(fn);
      return () => {};
    },
  } as unknown as AnyRouter;
  return { router, fireResolved: () => listeners.forEach((fn) => fn()) };
}

beforeEach(() => {
  // Fresh module state per test (the singleton posthog/activeRouter are reset).
  vi.resetModules();
  initSpy.mockClear();
  captureSpy.mockClear();
  startExceptionAutocaptureSpy.mockClear();
  captureExceptionSpy.mockClear();
  registerSpy.mockClear();
});

afterEach(() => {
  delete window.__TRADR_CONFIG__;
});

describe('initPostHogClient', () => {
  it('calls init with autocapture/pageview/pageleave/session-recording neutralized and persistence memory', async () => {
    window.__TRADR_CONFIG__ = {
      posthogPublicKey: 'phc_test',
      posthogPublicHost: 'https://eu.i.posthog.com',
    };
    const { initPostHogClient } = await import('./posthog');

    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));

    expect(initSpy).toHaveBeenCalledTimes(1);
    const [key, opts] = initSpy.mock.calls[0];
    expect(key).toBe('phc_test');
    expect(opts.api_host).toBe('https://eu.i.posthog.com');
    expect(opts.autocapture).toBe(false);
    expect(opts.capture_pageview).toBe(false);
    expect(opts.capture_pageleave).toBe(false);
    expect(opts.disable_session_recording).toBe(true);
    expect(opts.persistence).toBe('memory');
    expect(opts.disable_surveys).toBe(true);
    expect(opts.advanced_disable_toolbar_metrics).toBe(true);
    expect(typeof opts.before_send).toBe('function');
    // Web vitals is the one autocapture-family surface deliberately kept on;
    // network timing stays off. Pinned so the choice stays explicit rather than
    // reverting to the SDK default by omission.
    expect(opts.capture_performance).toEqual({ web_vitals: true, network_timing: false });
  });

  it('an event with no prior geoip properties still gets the disable directive', async () => {
    const { scrubEvent } = await import('./posthog');

    const out = scrubEvent({ properties: { keep: 'me' } as Record<string, unknown> });

    expect(out!.properties!.$geoip_disable).toBe(true);
    expect(out!.properties!.keep).toBe('me');
  });

  it('enables exception autocapture for unhandled errors + rejections, console errors off', async () => {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const { initPostHogClient } = await import('./posthog');

    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));

    expect(startExceptionAutocaptureSpy).toHaveBeenCalledTimes(1);
    expect(startExceptionAutocaptureSpy).toHaveBeenCalledWith({
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    });
  });

  it('defaults api_host to PostHog US cloud when posthogPublicHost is absent', async () => {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const { initPostHogClient } = await import('./posthog');

    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));

    expect(initSpy.mock.calls[0][1].api_host).toBe('https://us.i.posthog.com');
  });

  it('registers environment as a super property when posthogPublicEnvironment is set', async () => {
    window.__TRADR_CONFIG__ = {
      posthogPublicKey: 'phc_test',
      posthogPublicEnvironment: 'staging',
    };
    const { initPostHogClient } = await import('./posthog');

    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith({ environment: 'staging' });
  });

  it('registers nothing when posthogPublicEnvironment is absent (self-host default)', async () => {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const { initPostHogClient } = await import('./posthog');

    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));

    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('registers before the entry pageview, so the pageview carries the label', async () => {
    window.__TRADR_CONFIG__ = {
      posthogPublicKey: 'phc_test',
      posthogPublicEnvironment: 'production',
    };
    const { initPostHogClient } = await import('./posthog');

    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));

    expect(registerSpy).toHaveBeenCalled();
    expect(captureSpy).toHaveBeenCalledWith('$pageview');
    expect(registerSpy.mock.invocationCallOrder[0]).toBeLessThan(
      captureSpy.mock.invocationCallOrder[0],
    );
  });
});

describe('scrubEvent', () => {
  it('with no active route: drops url/referrer/title, disables geoip, drops $geoip_*', async () => {
    const { scrubEvent } = await import('./posthog');
    const event = {
      event: 'position_create_dialog_opened',
      properties: {
        $current_url: 'https://app.tradr.io/positions/abc123?token=supersecret',
        $referrer: 'https://google.com/search?q=tradr',
        title: 'Position abc123?x=1',
        $ip: '203.0.113.7',
        $geoip_city_name: 'London',
        $geoip_country_code: 'GB',
        keep: 'me',
      },
    };

    const out = scrubEvent(event);

    // before_send never returns null when given a real event (would drop it).
    expect(out).toBe(event);
    expect(out!.properties.$ip).toBeNull();
    // The directive the ingestion pipeline actually honours. It shares the
    // `$geoip_` prefix with the properties stripped below, so this also pins the
    // ordering: strip first, then set — the reverse deletes it again.
    expect((out!.properties as Record<string, unknown>).$geoip_disable).toBe(true);
    expect(out!.properties.$geoip_city_name).toBeUndefined();
    expect(out!.properties.$geoip_country_code).toBeUndefined();
    // No resolved route ⇒ URL/referrer/title are DROPPED, never the resolved path.
    expect(out!.properties.$current_url).toBeUndefined();
    expect(out!.properties.$referrer).toBeUndefined();
    expect(out!.properties.title).toBeUndefined();
    expect(out!.properties.keep).toBe('me');
  });

  it('with an active route: replaces url/referrer/title with the masked route PATTERN', async () => {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const { initPostHogClient, scrubEvent } = await import('./posthog');
    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));
    const expected = window.location.origin + PATTERN;

    const out = scrubEvent({
      properties: {
        $current_url: 'https://app.tradr.io/positions/abc123?token=supersecret',
        $referrer: 'https://google.com/search?q=tradr',
      },
    });

    expect(out!.properties.$current_url).toBe(expected);
    expect(out!.properties.$referrer).toBe(expected);
    expect(String(out!.properties.$current_url)).not.toContain('abc123');
    expect(String(out!.properties.$current_url)).not.toContain('?');
  });

  it('redacts exception-autocapture payloads (message + nested stack) but keeps type/frames', async () => {
    const { scrubEvent } = await import('./posthog');

    const out = scrubEvent({
      event: '$exception',
      properties: {
        $exception_message: 'Failed for john@example.com with sk-ant-abc123',
        $exception_list: [
          {
            type: 'TypeError',
            value: 'boom, ping admin@example.com',
            stacktrace: {
              frames: [{ filename: 'main.tsx', function: 'render', lineno: 42, colno: 10 }],
            },
          },
        ],
        $exception_values: ['leak sk-ant-xyz789', 'plain'],
        $exception_type: 'TypeError',
        $exception_level: 'error',
      },
    });

    const props = out!.properties as Record<string, unknown>;
    // Message + values: secrets/emails masked.
    expect(props.$exception_message).toBe('Failed for [redacted] with [redacted]');
    expect(props.$exception_values).toEqual(['leak [redacted]', 'plain']);
    // Structured list: message value scrubbed, but type + frame metadata intact
    // so PostHog still groups by exception type and shows the stack.
    const list = props.$exception_list as Array<{
      type: string;
      value: string;
      stacktrace: { frames: Array<{ filename: string; lineno: number }> };
    }>;
    expect(list[0].value).toBe('boom, ping [redacted]');
    expect(list[0].type).toBe('TypeError');
    expect(list[0].stacktrace.frames[0].filename).toBe('main.tsx');
    expect(list[0].stacktrace.frames[0].lineno).toBe(42);
    // Grouping metadata untouched.
    expect(props.$exception_type).toBe('TypeError');
    expect(props.$exception_level).toBe('error');
  });
});

describe('captureClientEvent', () => {
  it('is a no-op when PostHog is not initialized', async () => {
    const { captureClientEvent } = await import('./posthog');

    captureClientEvent('position_create_dialog_opened', { a: 'b' });

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('captures with scrubProperties-scrubbed properties (secret/email masked) once initialized', async () => {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const { initPostHogClient, captureClientEvent } = await import('./posthog');
    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));
    // init emits an entry $pageview; clear it so this asserts only the event below.
    captureSpy.mockClear();

    captureClientEvent('position_create_dialog_opened', {
      note: 'reach me at john@example.com',
      key: 'sk-ant-abc123def',
      count: 5,
    });

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [name, props] = captureSpy.mock.calls[0];
    expect(name).toBe('position_create_dialog_opened');
    expect(props.note).toBe('reach me at [redacted]');
    expect(props.key).toBe('[redacted]');
    expect(props.count).toBe(5);
  });
});

describe('captureClientException', () => {
  it('is a no-op when PostHog is not initialized', async () => {
    const { captureClientException } = await import('./posthog');

    captureClientException(new Error('boom'));

    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it('forwards the error and scrubs supplied context properties once initialized', async () => {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const { initPostHogClient, captureClientException } = await import('./posthog');
    await initPostHogClient(makeStubRouter([{ routeId: PATTERN }]));

    const err = new Error('kaboom');
    captureClientException(err, { where: 'contact me@example.com', code: 42 });

    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    const [passedErr, props] = captureExceptionSpy.mock.calls[0];
    expect(passedErr).toBe(err);
    expect(props.where).toBe('contact [redacted]');
    expect(props.code).toBe(42);
  });
});

describe('scrubProperties', () => {
  it('masks secret/email values, redacts deny-keys, and is non-string-safe', async () => {
    const { scrubProperties } = await import('./posthog');

    const out = scrubProperties({ email: 'a@b.com', msg: 'sk-ant-xyz', n: 3, ok: true });

    expect(out!.email).toBe('[redacted]'); // deny-key
    expect(out!.msg).toBe('[redacted]'); // value pattern
    expect(out!.n).toBe(3);
    expect(out!.ok).toBe(true);
    expect(scrubProperties(undefined)).toBeUndefined();
  });
});

describe('pageview capture', () => {
  it('emits an entry $pageview when the initial route already resolved at init', async () => {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const { initPostHogClient } = await import('./posthog');
    const { router } = makeFireableRouter([{ routeId: PATTERN }]);

    await initPostHogClient(router);

    expect(captureSpy).toHaveBeenCalledWith('$pageview');
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  it('emits a $pageview on each route resolve, with no eager entry capture when unresolved', async () => {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const { initPostHogClient } = await import('./posthog');
    const matches: Array<{ routeId: string }> = [];
    const { router, fireResolved } = makeFireableRouter(matches);

    await initPostHogClient(router);
    // Initial route not resolved yet ⇒ no eager entry pageview (no double count).
    expect(captureSpy).not.toHaveBeenCalled();

    // The router resolves its first route, then onResolved fires.
    matches.push({ routeId: PATTERN });
    fireResolved();
    expect(captureSpy).toHaveBeenCalledWith('$pageview');
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });
});

describe('module loading', () => {
  it('uses a dynamic import for posthog-js (no static value import)', () => {
    expect(posthogSource).toContain("await import('posthog-js')");
    // No static value import (`import … from 'posthog-js'`) — that would bundle
    // the SDK into the entry chunk. A type-only `typeof import()` is erased.
    // Anchored to line starts so comments mentioning the pattern don't match.
    expect(posthogSource).not.toMatch(/^\s*import\s+[^;\n]*\bfrom\s+['"]posthog-js['"]/m);
  });
});

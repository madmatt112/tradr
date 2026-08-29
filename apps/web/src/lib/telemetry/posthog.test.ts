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
    // No /flags request. Its POST body carries `$initial_current_url` RAW —
    // fragment and all — plus `$initial_referrer`, and it is the one vendor
    // request before_send never sees, so the only fix is not to make it. Pinned
    // here because the jsdom harness in posthog.leak.test.ts cannot reproduce
    // the request either way.
    expect(opts.advanced_disable_feature_flags).toBe(true);
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
  it('drops referrers, disables geoip, and passes URL properties through untouched', async () => {
    const { scrubEvent } = await import('./posthog');
    const event = {
      event: 'position_create_dialog_opened',
      properties: {
        $current_url: 'https://app.tradr.io/positions/abc123',
        $pathname: '/positions/abc123',
        $host: 'app.tradr.io',
        title: 'Position abc123',
        $referrer: 'https://google.com/search?q=tradr',
        $initial_referrer: 'https://google.com/search?q=tradr',
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

    // URL properties keep their natural SHAPES. Overwriting all of them with one
    // masked URL is what broke web analytics: $host and $pathname expect a
    // hostname and a path, and both were receiving a full URL.
    expect(out!.properties.$current_url).toBe('https://app.tradr.io/positions/abc123');
    expect(out!.properties.$pathname).toBe('/positions/abc123');
    expect(out!.properties.$host).toBe('app.tradr.io');
    expect(out!.properties.title).toBe('Position abc123');

    // Referrers are still dropped — an external origin is a different exposure
    // from our own paths.
    expect(out!.properties.$referrer).toBeUndefined();
    expect(out!.properties.$initial_referrer).toBeUndefined();
    expect(out!.properties.keep).toBe('me');
  });

  // /reset-password and /verify-email carry their emailed token in the URL
  // FRAGMENT (D6/REQ-3.9) specifically so it never leaves the browser. posthog-js
  // builds $current_url from window.location.href, which includes the fragment,
  // so sending the raw href would hand the token straight to the vendor.
  it.each([
    ['reset-password', 'https://app.tradr.io/reset-password#token=deadbeefcafe1234'],
    ['verify-email', 'https://app.tradr.io/verify-email#token=deadbeefcafe1234'],
  ])('strips the #token fragment from $current_url — %s', async (_route, href) => {
    const { scrubEvent } = await import('./posthog');

    const out = scrubEvent({ properties: { $current_url: href } as Record<string, unknown> });

    const sent = String(out!.properties!.$current_url);
    expect(sent).not.toContain('deadbeefcafe1234');
    expect(sent).not.toContain('#');
    expect(sent).toBe(href.split('#')[0]);
  });

  it('leaves a fragmentless URL — including its query string — intact', async () => {
    const { scrubEvent } = await import('./posthog');

    const out = scrubEvent({
      properties: {
        $current_url: 'https://app.tradr.io/login?expired=true',
      } as Record<string, unknown>,
    });

    // Query strings carry real analytics signal and no route puts a secret in
    // one (REQ-3.9), so they are deliberately kept.
    expect(out!.properties!.$current_url).toBe('https://app.tradr.io/login?expired=true');
  });

  it('drops referrers even when no route has resolved', async () => {
    const { scrubEvent } = await import('./posthog');

    const out = scrubEvent({
      properties: {
        $referrer: 'https://google.com/search?q=tradr',
        $current_url: 'https://app.tradr.io/login',
      } as Record<string, unknown>,
    });

    expect(out!.properties!.$referrer).toBeUndefined();
    // The URL still goes through — it no longer depends on router state at all.
    expect(out!.properties!.$current_url).toBe('https://app.tradr.io/login');
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

// The carriers: posthog-js synthesizes the raw entry
// href and document.referrer into `$session_entry_*` on EVERY event of a session,
// and nests the raw href again one object deep inside each `$web_vitals` metric.
// scrubEvent used to walk only the top-level property bag, so all of it went out
// unscrubbed — including the emailed reset token in the fragment.
//
// posthog.leak.test.ts proves the end-to-end behaviour against the real SDK on the
// wire; these pin the individual shapes, which is where a regression would land.
describe('scrubEvent — depth-agnostic URL guards', () => {
  const ORIGIN = window.location.origin;

  it('strips the fragment from $session_entry_url and drops the session-entry referrer family', async () => {
    const { scrubEvent } = await import('./posthog');

    const out = scrubEvent({
      properties: {
        $session_entry_url: `${ORIGIN}/reset-password?src=email#token=deadbeefcafe1234`,
        $session_entry_referrer: 'https://mail.example.com/inbox/42',
        $session_entry_referring_domain: 'mail.example.com',
        $session_entry_ph_keyword: 'tradr journal',
        ph_keyword: 'tradr journal',
      } as Record<string, unknown>,
    });

    const props = out!.properties as Record<string, unknown>;
    // Query kept, fragment gone — the query carries analytics signal, the
    // fragment carries the token.
    expect(props.$session_entry_url).toBe(`${ORIGIN}/reset-password?src=email`);
    expect(props.$session_entry_referrer).toBeUndefined();
    expect(props.$session_entry_ph_keyword).toBeUndefined();
    expect(props.ph_keyword).toBeUndefined();
    // The bare hostname survives — no path, no query, and channel reporting reads it.
    expect(props.$session_entry_referring_domain).toBe('mail.example.com');
  });

  it('strips the fragment from the $current_url NESTED inside a $web_vitals metric', async () => {
    const { scrubEvent } = await import('./posthog');

    // The shape posthog-js builds: one object per metric, each carrying its own
    // copy of the raw href.
    const out = scrubEvent({
      event: '$web_vitals',
      properties: {
        $web_vitals_FCP_event: {
          name: 'FCP',
          value: 1234,
          $current_url: `${ORIGIN}/verify-email#token=deadbeefcafe1234`,
        },
        $web_vitals_LCP_event: {
          name: 'LCP',
          value: 2345,
          $current_url: `${ORIGIN}/verify-email#token=deadbeefcafe1234`,
        },
      } as Record<string, unknown>,
    });

    const props = out!.properties as Record<string, unknown>;
    for (const key of ['$web_vitals_FCP_event', '$web_vitals_LCP_event']) {
      const metric = props[key] as Record<string, unknown>;
      expect(metric.$current_url).toBe(`${ORIGIN}/verify-email`);
      // Timing data is untouched — the point is the URL, not the metric.
      expect(typeof metric.value).toBe('number');
    }
  });

  it('rewrites an own-origin object KEY that carries a fragment ($heatmap_data)', async () => {
    const { scrubEvent } = await import('./posthog');

    // $heatmap_data is keyed BY the page URL, so a value-only walk cannot reach
    // it. Heatmaps are off in production today, but one project toggle turns them
    // on with no deploy.
    const out = scrubEvent({
      properties: {
        $heatmap_data: {
          [`${ORIGIN}/reset-password#token=deadbeefcafe1234`]: [{ x: 1, y: 2, type: 'click' }],
        },
      } as Record<string, unknown>,
    });

    const heatmap = (out!.properties as Record<string, unknown>).$heatmap_data as Record<
      string,
      unknown
    >;
    expect(Object.keys(heatmap)).toEqual([`${ORIGIN}/reset-password`]);
    expect(JSON.stringify(heatmap)).not.toContain('deadbeefcafe1234');
  });

  it('leaves a foreign-origin string and free text containing a # alone', async () => {
    const { scrubEvent } = await import('./posthog');

    const out = scrubEvent({
      properties: {
        // Own-origin matching is what makes the value rule safe to apply to
        // strings the SDK did not build: unrelated text keeps its '#'.
        note: 'ticket #42 is the follow-up',
        elsewhere: 'https://docs.example.com/guide#section-3',
      } as Record<string, unknown>,
    });

    const props = out!.properties as Record<string, unknown>;
    expect(props.note).toBe('ticket #42 is the follow-up');
    expect(props.elsewhere).toBe('https://docs.example.com/guide#section-3');
  });

  it('passes free-text survey subtrees through verbatim', async () => {
    const { scrubEvent } = await import('./posthog');

    // A bug report that opens with a pasted app URL and continues into prose
    // containing a '#' must not be truncated at that '#'. Inert today
    // (disable_surveys), pinned so the feedback surface inherits it.
    const body = `${window.location.origin}/positions/abc broke — see step #3 in my notes`;
    const out = scrubEvent({
      properties: {
        $survey_response_2: body,
        $survey_questions: [{ question: 'What broke?', response: body }],
      } as Record<string, unknown>,
    });

    const props = out!.properties as Record<string, unknown>;
    expect(props.$survey_response_2).toBe(body);
    expect((props.$survey_questions as Array<{ response: string }>)[0].response).toBe(body);
  });
});

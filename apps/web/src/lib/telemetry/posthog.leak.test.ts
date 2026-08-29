// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.tradr.io/reset-password?src=email#token=deadbeefcafe1234", "referrer": "https://mail.example.com/inbox/42" }

// End-to-end proof that no vendor request carries the entry-URL fragment or the
// full referrer.
//
// This file deliberately uses the REAL posthog-js — posthog.test.ts mocks it, so
// it can only assert what scrubEvent does to an event we hand it, never what the
// SDK actually puts on the wire. The leak lived precisely in the gap: properties
// the SDK synthesizes ($session_entry_*), nests ($web_vitals_<NAME>_event), or
// sends outside before_send entirely (the /flags POST).
//
// The docblock above sets both halves of the exposure: jsdom's `url` becomes
// window.location.href (fragment included — that is where the emailed reset token
// lives) and `referrer` becomes document.referrer.
//
// Assertions are decoded, not raw: the batch body is gzip, so a substring check
// against the raw ArrayBuffer would pass vacuously whether or not the token is in
// there.

import { gunzipSync } from 'node:zlib';

import type { AnyRouter } from '@tanstack/react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const TOKEN = 'deadbeefcafe1234';
const ENTRY_URL_NO_FRAGMENT = 'https://app.tradr.io/reset-password?src=email';
const REFERRER_PATH = 'mail.example.com/inbox/42';
const API_HOST = 'https://ph.example.test';

interface SentRequest {
  url: string;
  body: unknown;
}

const sent: SentRequest[] = [];

// posthog-js snapshots `globalThis.fetch` at MODULE LOAD (utils/globals.js binds
// `exports.fetch = global?.fetch`, and request.js reads that snapshot), so the
// stub has to be installed here — at the top of the file, before the dynamic
// `import('posthog-js')` inside initPostHogClient ever runs. Stubbing it inside a
// beforeEach would be too late.
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    sent.push({ url, body: init?.body });
    return new Response('{"status":1}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
);

/**
 * Decode a captured request body to text. posthog-js gzips the event batch when
 * CompressionStream is available (it is, under vitest's jsdom), so this has to
 * gunzip before any substring assertion means anything.
 */
async function decodeBody(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;

  let bytes: Uint8Array;
  if (body instanceof Blob) {
    bytes = new Uint8Array(await body.arrayBuffer());
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else if (body instanceof URLSearchParams) {
    return body.toString();
  } else {
    return String(body);
  }

  // gzip magic number — the SDK's native-compression path.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes).toString('utf8');
  }
  return new TextDecoder().decode(bytes);
}

/** Every event object in a decoded batch body, whatever envelope the SDK used. */
function eventsFrom(text: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Form-encoded fallback: `data=<json>`.
    const data = new URLSearchParams(text).get('data');
    if (!data) return [];
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === 'object') {
    const batch = (parsed as { batch?: unknown }).batch;
    if (Array.isArray(batch)) return batch as Array<Record<string, unknown>>;
    return [parsed as Record<string, unknown>];
  }
  return [];
}

function makeStubRouter(): AnyRouter {
  return {
    state: { matches: [{ routeId: '/reset-password' }] },
    subscribe: () => () => {},
  } as unknown as AnyRouter;
}

describe('no vendor request carries the reset token or the full referrer', () => {
  let decoded: string[];
  let events: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // Sanity-check the fixture itself: if jsdom did not honour the docblock, the
    // exposure under test would not exist and every assertion below would pass
    // for the wrong reason.
    expect(window.location.href).toContain(`#token=${TOKEN}`);
    expect(document.referrer).toBe(`https://${REFERRER_PATH}`);

    window.__TRADR_CONFIG__ = {
      posthogPublicKey: 'phc_leak_test',
      posthogPublicHost: API_HOST,
    };

    const { initPostHogClient } = await import('./posthog');
    await initPostHogClient(makeStubRouter());

    // REAL timers only. Fake timers cannot drive this flush: with
    // CompressionStream present the SDK gzips through an async native stream, so
    // advanceTimersByTime returns before the body is ever handed to fetch.
    await vi.waitFor(() => expect(sent.some((r) => r.url.includes('/e'))).toBe(true), {
      timeout: 15_000,
      interval: 50,
    });

    decoded = await Promise.all(sent.map((r) => decodeBody(r.body)));
    events = decoded.flatMap(eventsFrom);
    expect(events.length).toBeGreaterThan(0);
  }, 30_000);

  // Regression GUARD, not a reproduction. The /flags POST is the third carrier —
  // its body carries `$initial_current_url` raw plus `$initial_referrer` and never
  // passes through before_send — but it does not fire under this jsdom harness
  // even WITHOUT advanced_disable_feature_flags (measured: the only request either
  // way is the /e/ batch), so this assertion cannot prove that fix. What it does
  // do is fail if a future change starts making the request. The init option
  // itself is pinned in posthog.test.ts.
  it('makes no /flags request', () => {
    expect(sent.filter((r) => r.url.includes('/flags'))).toEqual([]);
  });

  it('sends $session_entry_url with the query kept and the fragment gone', () => {
    const props = events[0].properties as Record<string, unknown>;
    // Presence, not just absence: proving the token is gone is worthless if the
    // property was simply never sent, which would make the test pass forever.
    expect(props.$session_entry_url).toBe(ENTRY_URL_NO_FRAGMENT);
    expect(props.$current_url).toBe(ENTRY_URL_NO_FRAGMENT);
  });

  it('keeps the referring DOMAIN but drops every full-referrer property', () => {
    const props = events[0].properties as Record<string, unknown>;
    // A bare hostname is what channel reporting reads; it carries no path or query.
    expect(props.$session_entry_referring_domain).toBe('mail.example.com');
    expect(props.$session_entry_referrer).toBeUndefined();
    expect(props.$referrer).toBeUndefined();
    expect(props.$initial_referrer).toBeUndefined();
  });

  it('leaks the token nowhere in any decoded request body', () => {
    for (const text of decoded) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('#token');
    }
  });

  it('leaks the full referrer URL nowhere in any decoded request body', () => {
    for (const text of decoded) {
      expect(text).not.toContain(REFERRER_PATH);
    }
  });
});

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
const OWN_ORIGIN = 'https://app.tradr.io';
const ENTRY_URL_NO_FRAGMENT = 'https://app.tradr.io/reset-password?src=email';
const REFERRER_PATH = 'mail.example.com/inbox/42';
const API_HOST = 'https://ph.example.test';

// The three ids for the deliberate `survey sent` capture. Held here so the wire
// assertions and the seenSurvey_ removal both reference the same surveyId.
const IDS = {
  surveyId: 'sid-0001',
  ratingQuestionId: 'rate-q1',
  textQuestionId: 'text-q1',
} as const;
const SUBMISSION_ID = '11111111-2222-4333-8444-555555555555';
const RATING = 4;
// Free text carrying a secret + an email + a filename: scrubFeedbackText masks the
// first two and KEEPS the .csv (REQ-6). The scrubbed value is what reaches the wire.
const FEEDBACK_TEXT = 'ticket sk-abc123XYZ from a@b.com re schwab-2024.csv';
const FEEDBACK_TEXT_SCRUBBED = 'ticket [redacted] from [redacted] re schwab-2024.csv';

// A $heatmap_data key: an own-origin URL WITH a fragment. $heatmap_data is keyed
// BY the page URL, so a value-only walk cannot reach it — scrubEvent must rewrite
// the KEY, dropping the fragment (posthog.ts scrubUrlEntries).
const HEATMAP_URL = `${OWN_ORIGIN}/positions/42`;
const HEATMAP_KEY_WITH_FRAGMENT = `${HEATMAP_URL}#token=${TOKEN}`;

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

    const { initPostHogClient, captureFeedbackSent } = await import('./posthog');
    await initPostHogClient(makeStubRouter());

    // Deliberate product events that must ride the SAME decoded batch the leak
    // proof ranges over. captureFeedbackSent sends the real `survey sent` (five
    // keys, scrubbed text) through the installed SDK; a hand-rolled capture carries
    // a $heatmap_data-shaped property keyed by an own-origin URL WITH a fragment
    // (heatmaps are off, so it never fires on its own). Both go through
    // before_send: scrubEvent on the wire, exactly like every other event.
    captureFeedbackSent(IDS, SUBMISSION_ID, RATING, FEEDBACK_TEXT);
    const { default: ph } = await import('posthog-js');
    ph.capture('feedback_heatmap_probe', {
      $heatmap_data: { [HEATMAP_KEY_WITH_FRAGMENT]: [{ x: 1, y: 2, target_fixed: false }] },
    });

    // REAL timers only. Fake timers cannot drive this flush: with
    // CompressionStream present the SDK gzips through an async native stream, so
    // advanceTimersByTime returns before the body is ever handed to fetch. Wait
    // until BOTH deliberate events have reached the wire, then snapshot the batch.
    await vi.waitFor(
      async () => {
        decoded = await Promise.all(sent.map((r) => decodeBody(r.body)));
        events = decoded.flatMap(eventsFrom);
        expect(events.some((e) => e.event === 'survey sent')).toBe(true);
        expect(events.some((e) => e.event === 'feedback_heatmap_probe')).toBe(true);
      },
      { timeout: 15_000, interval: 50 },
    );

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

  it('lands `survey sent` on the wire with the five keys, the scrubbed text, and no $set', () => {
    const survey = events.find((e) => e.event === 'survey sent');
    expect(survey).toBeDefined();
    const props = survey!.properties as Record<string, unknown>;
    // The five keys the wrapper sends (design Component 6), present with the right
    // values. The SDK's own auto-properties ride alongside, so this is a superset
    // check — key-set equality is posthog.test.ts's mocked job.
    expect(props.$survey_id).toBe(IDS.surveyId);
    expect(props.$survey_submission_id).toBe(SUBMISSION_ID);
    expect(props.$survey_completed).toBe(true);
    expect(props[`$survey_response_${IDS.ratingQuestionId}`]).toBe(RATING);
    expect(props[`$survey_response_${IDS.textQuestionId}`]).toBe(FEEDBACK_TEXT_SCRUBBED);
    // scrubEvent strips the injected person-profile mutation off every event; core
    // capture() sets a top-level $set on a `survey sent` (posthog-core.js:1071-1080).
    expect(survey!.$set).toBeUndefined();
    expect(survey!.$set_once).toBeUndefined();
  });

  it('removes the seenSurvey_ key the SDK writes for a `survey sent`', async () => {
    const { captureFeedbackSent } = await import('./posthog');
    const key = `seenSurvey_${IDS.surveyId}`;
    // Clean slate so the SDK's own "already seen?" guard does not skip its write.
    localStorage.removeItem(key);

    // Two other writers hit setItem at init regardless of persistence mode
    // (_checkLocalStorageForDebug's __mplssupport__, the toolbar loader's test), so
    // match specifically on this key. spyOn calls through, so the real write lands.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      captureFeedbackSent(IDS, crypto.randomUUID(), 3, '');
      // The SDK's core capture() writes the seen key for every `survey sent`.
      expect(setItem.mock.calls.some(([k]) => k === key)).toBe(true);
    } finally {
      setItem.mockRestore();
    }
    // ...and the wrapper's `finally` removed it: no key persists past the capture
    // (REQ-5.6). An absence without the observed write above would prove nothing.
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('rewrites a $heatmap_data key from an own-origin URL, dropping the fragment, on the wire', () => {
    const evt = events.find((e) => e.event === 'feedback_heatmap_probe');
    expect(evt).toBeDefined();
    const heatmap = (evt!.properties as Record<string, unknown>).$heatmap_data as Record<
      string,
      unknown
    >;
    const keys = Object.keys(heatmap);
    // The fragment-bearing key is rewritten to the fragmentless own-origin URL.
    expect(keys).toContain(HEATMAP_URL);
    expect(keys.every((k) => !k.includes('#'))).toBe(true);
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

  // The derived $web_vitals carrier: posthog-js nests the raw href one metric-object
  // deep in `$web_vitals_<NAME>_event.$current_url`, which a top-level pass never
  // reached. Instantiate the installed SDK's own WebVitalsAutocapture against the
  // real instance, buffer a fake metric and flush — deriving the shape from the SDK
  // (an SDK rename is caught) rather than hand-building it. The flush lands in a
  // SECOND /e/ batch after the beforeAll snapshot, so this waits on its own later
  // request and re-decodes; it does NOT reuse the beforeAll `decoded`/`events`.
  it('strips the fragment from $current_url nested in a derived $web_vitals event', async () => {
    const { default: ph } = await import('posthog-js');
    const { WebVitalsAutocapture } = await import('posthog-js/lib/src/extensions/web-vitals');

    // _addToBuffer / _flushToCapture are private in the .d.ts, and the constructor's
    // PostHog type comes from a different declaration than the default export's — a
    // structural cast reaches both (test-only) without re-implementing the metric
    // shape or weakening the SDK's own types.
    const WV = WebVitalsAutocapture as unknown as new (instance: unknown) => {
      _addToBuffer: (metric: { name: string; value: number }) => void;
      _flushToCapture: () => void;
    };
    const wv = new WV(ph);
    wv._addToBuffer({ name: 'LCP', value: 123 });
    wv._flushToCapture();

    // REAL timers, above the 3 s flush. Find the later batch carrying the metric.
    let wvText = '';
    await vi.waitFor(
      async () => {
        for (const r of sent) {
          const text = await decodeBody(r.body);
          if (text.includes('$web_vitals_LCP_event')) {
            wvText = text;
            return;
          }
        }
        throw new Error('web vitals batch not on the wire yet');
      },
      { timeout: 15_000, interval: 50 },
    );

    const wvEvent = eventsFrom(wvText).find((e) => e.event === '$web_vitals');
    expect(wvEvent).toBeDefined();
    const metric = (wvEvent!.properties as Record<string, unknown>).$web_vitals_LCP_event as Record<
      string,
      unknown
    >;
    // Query kept, fragment (the emailed token) gone — proven on the wire, not just
    // through scrubEvent (posthog.test.ts pins the fast mocked twin).
    expect(metric.$current_url).toBe(ENTRY_URL_NO_FRAGMENT);
    expect(wvText).not.toContain(TOKEN);
  }, 30_000);
});

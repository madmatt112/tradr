// Gated, privacy-neutralized PostHog browser SDK + a value-scrubbed direct
// capture wrapper for deliberate product events (design Component 9, REQ-3).
//
// posthog-js is loaded via a DYNAMIC import so Vite emits it as a separate async
// chunk and it never lands in the entry chunk (REQ-9.2 path (i)). This module
// MUST NOT statically `import … from 'posthog-js'` — only the `await import()`
// below (and a type-only `typeof import()`, which is erased at build time) refer
// to the package. A regression to a static value import would surface in the
// entry chunk and trip the CI bundle gate (Component 10).

import type { AnyRouter } from '@tanstack/react-router';

import { getTelemetryConfig } from './config';

// Default PostHog Cloud ingestion host; a self-hoster overrides it with
// posthogPublicHost (POSTHOG_PUBLIC_HOST).
const DEFAULT_API_HOST = 'https://us.i.posthog.com';

// The dynamically-imported posthog-js default export. Typed via a type-only
// `typeof import(...)` (no runtime import, no entry-chunk impact) so init/capture
// are checked against the installed SDK's real shapes.
type PostHog = (typeof import('posthog-js'))['default'];

// Module-singleton SDK instance — set only after a successful gated init. Used
// by captureClientEvent to no-op when PostHog is absent/uninitialized.
let posthog: PostHog | undefined;

/**
 * Whether the router has resolved a route for the current location. Reads the
 * last entry of router.state.matches, which resolves asynchronously — so this is
 * false for the brief window before the first match lands, and the caller skips
 * the entry pageview rather than emitting one for a location the router has not
 * settled on yet.
 */
export function hasResolvedRoute(router: AnyRouter): boolean {
  const { matches } = router.state;
  return !!matches[matches.length - 1]?.routeId;
}

// Referrer properties are DROPPED, at ANY depth. A referrer can carry an
// EXTERNAL origin and its query string — a different exposure from our own
// paths, and nothing in web analytics' installation health needs it. Dropping
// keeps third-party navigation history out of the payload.
//
// `$session_entry_referrer` / `$session_entry_ph_keyword` are the session-entry
// mirrors: posthog-js' SessionPropsManager spreads getPersonInfo() — the raw
// entry href and `document.referrer` — onto EVERY event, and they persist for
// the whole session, so a top-level `$referrer` drop never reached them.
// `ph_keyword` is the search term the SDK parses out of the referrer's query.
// `$session_entry_referring_domain` is deliberately KEPT: a bare hostname, no
// path and no query, and it is what channel reporting reads.
const DROP_REFERRER_KEYS: ReadonlySet<string> = new Set([
  '$referrer',
  '$initial_referrer',
  '$session_entry_referrer',
  'ph_keyword',
  '$session_entry_ph_keyword',
]);

// URL properties posthog-js builds from `window.location.href`, which INCLUDES
// the `#fragment`. The fragment must be stripped before send: the password-reset
// and email-verification links deliberately carry their token there
// (`/reset-password#token=<hex>`, D6/REQ-3.9) precisely so it never leaves the
// browser, and sending the raw href would hand that token to the vendor. Query
// strings are kept — no route puts a secret in one (REQ-3.9) and they carry real
// analytics signal. Fragments carry none.
//
// Matched at ANY depth: `$session_entry_url` rides every event of the session,
// and `$web_vitals_<NAME>_event.$current_url` nests one metric-object deep.
const FRAGMENT_BEARING_KEYS: ReadonlySet<string> = new Set([
  '$current_url',
  '$initial_current_url',
  '$session_entry_url',
]);

// Depth cap for the URL walk. Event property trees are shallow — the deepest the
// SDK builds is `$exception_list` -> stacktrace -> frames — so this only bites on
// a pathological or cyclic structure, where it stops the walk rather than hang
// the tab.
const MAX_URL_WALK_DEPTH = 8;

/**
 * Subtrees the app deliberately sends verbatim: free text the user typed. A bug
 * report that opens with a pasted app URL and then continues into prose
 * containing a '#' would otherwise be truncated at that '#'. Surveys are off
 * today (`disable_surveys`), so this is inert until the feedback surface ships.
 */
function isFreeTextKey(key: string): boolean {
  return key.startsWith('$survey_response') || key === '$survey_questions';
}

/** The URL with any `#fragment` removed. Returns non-strings untouched. */
function stripFragment(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const hash = value.indexOf('#');
  return hash === -1 ? value : value.slice(0, hash);
}

/**
 * The app's own origin, or undefined when there is no usable one (non-browser,
 * or an opaque `null` origin). Decides which arbitrary strings are our URLs and
 * may therefore lose a fragment.
 */
function ownOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const origin = window.location?.origin;
  return origin && origin !== 'null' ? origin : undefined;
}

/**
 * Recurse plain objects/arrays, applying the URL guards at EVERY depth:
 *
 * - a DROP_REFERRER_KEYS key is removed;
 * - a FRAGMENT_BEARING_KEYS key loses its value's `#fragment` unconditionally —
 *   those keys are always URLs, never free text, whatever the origin;
 * - any other string VALUE, and any object KEY, beginning with our own origin
 *   loses its `#fragment`. Keys must be rewritten too because `$heatmap_data` is
 *   keyed BY the page URL, which a value-only walk cannot reach. Two keys that
 *   differ only by fragment collapse — last wins, which is fine for heatmaps;
 * - free-text subtrees (isFreeTextKey) pass through verbatim.
 *
 * Own-origin matching is what makes the value rule safe to apply to strings the
 * SDK did not build: it closes the class (any URL property the SDK invents next)
 * without truncating unrelated text that happens to contain a '#'.
 *
 * Returns a new structure; the caller swaps it in.
 */
function scrubUrlsDeep(value: unknown, origin: string | undefined, depth = 0): unknown {
  if (depth >= MAX_URL_WALK_DEPTH) return value;
  if (typeof value === 'string') {
    return origin && value.startsWith(origin) ? stripFragment(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => scrubUrlsDeep(item, origin, depth + 1));
  if (!isPlainObject(value)) return value;
  return scrubUrlEntries(value, origin, depth);
}

/**
 * scrubUrlsDeep's object case, split out so scrubEvent can apply it to the root
 * property bag UNCONDITIONALLY. Going through scrubUrlsDeep for the root would
 * make the whole guard hinge on isPlainObject: a bag with an unexpected
 * prototype would be returned untouched and the scrub would silently become a
 * no-op — the one failure mode a credential guard must not have.
 */
function scrubUrlEntries(
  obj: Record<string, unknown>,
  origin: string | undefined,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (DROP_REFERRER_KEYS.has(key)) continue;
    const outKey = origin && key.startsWith(origin) ? (stripFragment(key) as string) : key;
    if (isFreeTextKey(key)) out[outKey] = val;
    else if (FRAGMENT_BEARING_KEYS.has(key)) out[outKey] = stripFragment(val);
    else out[outKey] = scrubUrlsDeep(val, origin, depth + 1);
  }
  return out;
}

// Exception-autocapture ($exception) properties that carry the error message and
// stack frames — the highest-entropy client payload, able to embed an
// email/secret/token from a thrown value. scrubEvent runs each through scrubDeep
// (the same value-scrubber captureClientEvent applies), mirroring the backend
// redactError so no autocaptured exception reaches the vendor unmasked (REQ-8.5).
// Type/level metadata ($exception_type etc.) is deliberately left intact so
// PostHog still groups issues by exception type.
const EXCEPTION_VALUE_KEYS = [
  '$exception_message',
  '$exception_list',
  '$exception_values',
] as const;

/** Minimal structural view of a posthog-js capture event for before_send. */
interface PostHogCaptureLike {
  properties?: Record<string, unknown>;
}

/**
 * before_send hook: the value-level capture-boundary guard over PostHog's own
 * auto-properties.
 *
 * URL properties ($current_url, $pathname, $host, title) are sent with the SDK's
 * natural values, MINUS any `#fragment` (see FRAGMENT_BEARING_KEYS — that is
 * where the emailed reset/verification tokens live). They were previously
 * overwritten with the matched route
 * PATTERN, which put a full URL into every one of them; $host and $pathname
 * expect a hostname and a path respectively, so web analytics could not read the
 * installation. Sending resolved URLs means in-app record ids (e.g. a position
 * id in /positions/:id) DO reach PostHog — a deliberate reversal of the original
 * masking, taken to make web analytics usable. See .env.example's privacy note.
 *
 * Both guards run at EVERY depth (scrubUrlsDeep), not just over the top-level
 * property bag. That is deliberate: posthog-js mirrors the raw entry href and
 * `document.referrer` into `$session_entry_url` / `$session_entry_referrer` on
 * EVERY event of the session, and nests the raw href again inside each
 * `$web_vitals_<NAME>_event`. A top-level pass reached none of it, so the
 * emailed reset token rode every event of a reset-password session.
 *
 * Referrers are still dropped (DROP_REFERRER_KEYS): an external referrer is a
 * different exposure from our own paths. Sets `$geoip_disable` to suppress
 * server-side geo enrichment and removes any `$geoip_*` already present. Also
 * redacts exception-autocapture payloads (message + stack) via scrubDeep
 * (EXCEPTION_VALUE_KEYS) — REQ-8.5, unchanged.
 *
 * ALWAYS returns the (mutated) event; returning `null` would drop the event,
 * which is never the intent here.
 */
export function scrubEvent<T extends PostHogCaptureLike>(event: T | null): T | null {
  if (!event || !event.properties) return event;

  // Drop referrers and strip own-origin `#fragment`s at EVERY depth, then swap
  // the rewritten bag in (the event object's identity is preserved). Walking the
  // whole tree is what catches the carriers a top-level pass missed:
  // `$session_entry_url` / `$session_entry_referrer` ride EVERY event of the
  // session, and `$web_vitals_<NAME>_event.$current_url` nests one object deep.
  const props = scrubUrlEntries(event.properties as Record<string, unknown>, ownOrigin(), 0);
  event.properties = props;

  // Suppress server-side geo enrichment. `$geoip_disable` is the property the
  // ingestion pipeline actually honours; setting `$ip = null` does NOT stop it
  // (verified against live data — events still arrived carrying $geoip_city_name).
  // `$ip = null` is kept only to state the payload's intent: it does not remove
  // the stored IP either, because PostHog takes that from the connection, not the
  // body. Discarding the stored IP is a PROJECT-LEVEL setting ("Discard client IP
  // data") and cannot be done from the SDK — see .env.example's operator note.
  // Order matters: strip any derived $geoip_* FIRST, then set the directive —
  // `$geoip_disable` itself matches the `$geoip_` prefix, so setting it before
  // the strip loop would delete it again.
  for (const key of Object.keys(props)) {
    if (key.startsWith('$geoip_')) delete props[key];
  }
  props.$geoip_disable = true;
  props.$ip = null;

  // Redact exception-autocapture payloads: run the message + structured stack
  // frames through scrubDeep so an email/secret embedded in a thrown value never
  // reaches PostHog unmasked (REQ-8.5) — the frontend mirror of backend
  // redactError. scrubDeep recurses $exception_list's nested frames; non-string
  // frame fields (line numbers, booleans) pass through untouched.
  for (const key of EXCEPTION_VALUE_KEYS) {
    if (key in props) props[key] = scrubDeep(props[key]);
  }

  return event;
}

/**
 * Initialize the gated, privacy-neutralized PostHog browser SDK. Call from
 * main.tsx only when isPostHogClientConfigured(). The dynamic import keeps
 * posthog-js out of the entry chunk.
 */
export async function initPostHogClient(router: AnyRouter): Promise<void> {
  const cfg = getTelemetryConfig();
  if (!cfg.posthogPublicKey) return;

  const ph = (await import('posthog-js')).default;
  ph.init(cfg.posthogPublicKey, {
    api_host: cfg.posthogPublicHost ?? DEFAULT_API_HOST,
    autocapture: false, // REQ-3.4a — no DOM text/input metadata
    // Automatic pageview capture stays OFF; we emit one per router route-resolve
    // below. The SDK populates $current_url / $pathname / $host from
    // window.location at capture time, and before_send no longer overwrites them.
    capture_pageview: false,
    // Deliberately off. PostHog's web-analytics installation check flags this as
    // making bounce rate and session duration inaccurate — an accepted cost, not
    // an oversight. Flip to true if those two metrics start mattering.
    capture_pageleave: false,
    disable_session_recording: true, // REQ-3.4b — never record the trading UI
    persistence: 'memory', // REQ-3.7 — cookieless/no-localStorage distinct_id
    disable_surveys: true,
    // Web vitals ($web_vitals) — performance timings only, no DOM or input data.
    // Stated explicitly because it defaults ON: it is the one autocapture-family
    // surface deliberately kept, so an unset field cannot be mistaken for an
    // oversight. Set to false to turn it off.
    capture_performance: { web_vitals: true, network_timing: false },
    advanced_disable_toolbar_metrics: true,
    // No /flags request. The app reads no feature flags (zero isFeatureEnabled /
    // getFeatureFlag / onFeatureFlags call sites), and the flags POST is the one
    // vendor request before_send never sees: its body carries
    // `$initial_current_url` RAW — fragment and all — plus `$initial_referrer`,
    // on first load and again every 5 minutes. Remote config is unaffected.
    // Side effect: `$active_feature_flags` stops riding events, which is moot
    // while there are no flags to report.
    advanced_disable_feature_flags: true,
    before_send: scrubEvent,
  });
  posthog = ph;

  // Stamp the deployment label ('production', 'staging') onto EVERY event as a
  // super property — including the ones we never call capture() for ourselves:
  // autocaptured $exception and $web_vitals. register() runs before before_send,
  // so scrubEvent sees the property and passes it through untouched (the label is
  // not a referrer, a geoip key, an exception payload, or an own-origin URL).
  // Skipped when the
  // deploy did not set posthogPublicEnvironment — the self-host default, where
  // there is one deployment and nothing to tell apart. Super properties live in
  // the memory-only persistence store (REQ-3.7), so this stays cookieless.
  if (cfg.posthogPublicEnvironment) {
    ph.register({ environment: cfg.posthogPublicEnvironment });
  }

  // Enable client-side exception autocapture: window errors + unhandled promise
  // rejections. Console errors stay OFF — a console.error is not an exception and
  // would be noise. Every $exception event routes through before_send: scrubEvent,
  // which redacts the message + stack (EXCEPTION_VALUE_KEYS) before send. Enabled
  // via the public startExceptionAutocapture() method (type-checked against the
  // installed SDK, since capture_exceptions is not a typed init field); enabling
  // it client-side does not depend on the PostHog project-side autocapture toggle.
  ph.startExceptionAutocapture({
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
    capture_console_errors: false,
  });

  // One pageview per client-side navigation. The SDK reads window.location at
  // capture time, so each carries the resolved URL, path, and host that web
  // analytics needs. Referrers are still dropped in before_send, and persistence
  // is memory-only, so pageviews stay cookieless.
  router.subscribe('onResolved', () => ph.capture('$pageview'));
  // Capture the entry pageview if the initial route already resolved during the
  // async import above (its first onResolved may have fired before we
  // subscribed). Guarded on resolved matches, so it never double-counts: when
  // the route has not resolved yet this is skipped and the first onResolved emits
  // the entry pageview instead.
  if (hasResolvedRoute(router)) ph.capture('$pageview');
}

// ---------------------------------------------------------------------------
// Value scrubber — a frontend mirror of the backend scrubDeep
// (apps/api/src/lib/telemetry-redact.ts). The frontend cannot import the api
// module, so the same secret/PII/email/filename pattern set is reimplemented
// here (REQ-8.5 capture-boundary value step over developer-supplied props).
// ---------------------------------------------------------------------------

const REDACTED = '[redacted]';

const VALUE_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic API keys (hyphen form: sk-, sk-ant-, sk-proj-)
  /\bsk-[A-Za-z0-9_-]+/g,
  // Stripe keys (underscore form: sk_, rk_, whsec_)
  /\b(?:sk|rk|whsec)_[A-Za-z0-9_]+/g,
  // PostHog keys (phc_, phx_)
  /\b(?:phc|phx)_[A-Za-z0-9_]+/g,
  // Authorization bearer tokens
  /Bearer\s+\S+/g,
  // JSON Web Tokens
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  // Anchored email address
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Uploaded image / document filenames
  /[\w-]+\.(?:png|jpe?g|webp|gif|pdf|csv|xlsx?)/g,
];

const DENY_KEYS: ReadonlySet<string> = new Set([
  'password',
  'token',
  'apikey',
  'api_key',
  'secret',
  'authorization',
  'cookie',
  'sessiontoken',
  'session',
  'encryptionkey',
  'refreshtoken',
  'accesstoken',
  'clientsecret',
  'email',
]);

/** Mask every secret / email / filename substring in a string value. */
function scrubString(s: string): string {
  let out = s;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recurse plain objects/arrays: a denylisted key (case-insensitive) masks its
 * value; every string passes through scrubString; non-strings are left
 * untouched so it never throws (non-string-safe).
 */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = DENY_KEYS.has(key.toLowerCase()) ? REDACTED : scrubDeep(val);
    }
    return out;
  }
  return value;
}

/** The capture-boundary value guard over developer-supplied event properties. */
export function scrubProperties(
  properties?: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> | undefined {
  if (!properties) return properties;
  return scrubDeep(properties) as Record<string, string | number | boolean>;
}

/**
 * Capture a deliberate product event. No-op when PostHog is absent/uninitialized
 * (the surface was not configured). Properties are value-scrubbed before send.
 * Call directly at feature touch-points, NOT through the Zustand event bus.
 */
export function captureClientEvent(
  name: string,
  properties?: Record<string, string | number | boolean>,
): void {
  if (!posthog) return;
  posthog.capture(name, scrubProperties(properties));
}

/**
 * Capture a caught client-side exception — e.g. a render error from the root
 * error boundary. No-op when PostHog is absent/uninitialized, so a self-hoster
 * without PostHog still gets the boundary's fallback UI with zero telemetry side
 * effect. The error's message + stack are redacted at the before_send boundary
 * (scrubEvent, EXCEPTION_VALUE_KEYS) — the same path autocaptured exceptions
 * take — so no extra scrubbing is needed here; developer-supplied context in
 * `properties` is value-scrubbed via scrubProperties.
 */
export function captureClientException(
  error: unknown,
  properties?: Record<string, string | number | boolean>,
): void {
  if (!posthog) return;
  posthog.captureException(error, scrubProperties(properties));
}

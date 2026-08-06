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

// The router, captured at init time, so scrubEvent (a single-arg before_send
// hook) can resolve the masked route pattern for the current location.
let activeRouter: AnyRouter | undefined;

/**
 * The masked URL for the current location: the matched route's PATTERN id
 * (e.g. `/_auth/positions/$positionId`), origin-prefixed. Reads the last entry
 * of router.state.matches — its `routeId`, which in @tanstack/react-router is
 * the route PATTERN, not the resolved path — so no resolved id, query string, or
 * referrer is ever sent. Guarded for empty matches (the router's first match
 * resolves asynchronously): returns undefined so the caller skips the pageview.
 */
export function maskedUrl(router: AnyRouter): string | undefined {
  const { matches } = router.state;
  const routeId = matches[matches.length - 1]?.routeId;
  if (!routeId) return undefined;
  return window.location.origin + routeId;
}

// PostHog auto-properties that can carry a resolved id, query string, or
// referrer (REQ-3.4/8.2). scrubEvent replaces them with the masked route pattern
// (or, absent a router, strips the query/fragment as a privacy floor).
const MASK_URL_KEYS = [
  '$current_url',
  '$pathname',
  '$referrer',
  '$host',
  '$initial_referrer',
  'title',
] as const;

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
 * before_send hook (REQ-8.5/3.4): the value-level capture-boundary guard over
 * PostHog's own auto-properties. Replaces URL/title properties with the masked
 * route pattern (no resolved id, no query string, no referrer). When no route has
 * resolved yet (no active match), it **drops** the property rather than emit the
 * resolved path — the route pattern is the only URL value ever sent. Sets
 * `$geoip_disable` to suppress server-side geo enrichment (REQ-3.4c/8.2) and
 * removes any `$geoip_*` already present. Also redacts exception-autocapture
 * payloads (message + stack) via scrubDeep before send (EXCEPTION_VALUE_KEYS).
 * ALWAYS returns the (mutated) event; returning `null` would drop the event,
 * which is never the intent here.
 */
export function scrubEvent<T extends PostHogCaptureLike>(event: T | null): T | null {
  if (!event || !event.properties) return event;
  const props = event.properties as Record<string, unknown>;

  const masked = activeRouter ? maskedUrl(activeRouter) : undefined;
  for (const key of MASK_URL_KEYS) {
    if (typeof props[key] !== 'string') continue;
    if (masked) props[key] = masked;
    else delete props[key]; // no resolved route ⇒ drop rather than leak the path
  }

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

  activeRouter = router;
  const ph = (await import('posthog-js')).default;
  ph.init(cfg.posthogPublicKey, {
    api_host: cfg.posthogPublicHost ?? DEFAULT_API_HOST,
    autocapture: false, // REQ-3.4a — no DOM text/input metadata
    // Automatic pageview capture stays OFF; we emit masked pageviews manually on
    // each route resolve below so the route PATTERN is sent, never the raw URL.
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true, // REQ-3.4b — never record the trading UI
    persistence: 'memory', // REQ-3.7 — cookieless/no-localStorage distinct_id
    disable_surveys: true,
    // Web vitals ($web_vitals) — performance timings only, no DOM or input data,
    // and its URL properties are masked to the route pattern by before_send like
    // every other event. Stated explicitly because it defaults ON: it is the one
    // autocapture-family surface deliberately kept, so an unset field cannot be
    // mistaken for an oversight. Set to false to turn it off.
    capture_performance: { web_vitals: true, network_timing: false },
    advanced_disable_toolbar_metrics: true,
    before_send: scrubEvent,
  });
  posthog = ph;

  // Stamp the deployment label ('production', 'staging') onto EVERY event as a
  // super property — including the ones we never call capture() for ourselves:
  // autocaptured $exception and the masked $pageview below. register() runs
  // before before_send, so scrubEvent sees the property and passes it through
  // untouched (it only rewrites the URL/geoip/exception keys). Skipped when the
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

  // Masked pageview on every client-side navigation. before_send (scrubEvent)
  // replaces $current_url with the route PATTERN — no resolved id, query string,
  // or referrer — and persistence is memory-only, so pageviews stay cookieless.
  router.subscribe('onResolved', () => ph.capture('$pageview'));
  // Capture the entry pageview if the initial route already resolved during the
  // async import above (its first onResolved may have fired before we
  // subscribed). Guarded on resolved matches, so it never double-counts: when
  // the route has not resolved yet this is skipped and the first onResolved emits
  // the entry pageview instead.
  if (maskedUrl(router)) ph.capture('$pageview');
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

// PostHog backend client + explicit business-event capture (design Component 4,
// REQ-4.1/4.3/4.5, REQ-1.2/1.4, REQ-8.5). Explicit capture at service
// touch-points — NOT a generic HTTP middleware (answers design §19 Q3). When
// configured, named business events are fire-and-forget captured (no DB
// connection, never on the SSE stream path); when unconfigured it is a clean
// no-op (no client constructed — graceful absence, REQ-1.2).

import { PostHog } from 'posthog-node';

import { config, isPostHogConfigured } from './config';
import { logTelemetryFailureOnce } from './telemetry-failure';
import { scrubDeep, scrubString } from './telemetry-redact';

// Batching tunables for a low-volume business-event stream. Conservative,
// SDK-default values: batch up to 20 events, otherwise flush every 10s; the
// graceful-shutdown flush (Component 5) drains the buffer on exit.
const FLUSH_AT = 20;
const FLUSH_INTERVAL_MS = 10_000;

// Module-level singleton. Constructed eagerly by initPostHog() only when
// configured; stays null otherwise. Eager construction (not lazy-on-first-
// capture) removes the concurrent-first-call race where two simultaneous first
// captures both build a client and strand one's buffer + flush timer.
let client: PostHog | null = null;

/**
 * Construct the PostHog client. Called once from index.ts main() before serve().
 * No-op when unconfigured: no client is constructed, so captureServerEvent stays
 * a no-op (REQ-1.2/4.5). config.POSTHOG_HOST is always a valid URL per its
 * envSchema default — no `??` fallback needed.
 */
export function initPostHog(): void {
  if (!isPostHogConfigured()) return;
  client = new PostHog(config.POSTHOG_API_KEY!, {
    host: config.POSTHOG_HOST,
    flushAt: FLUSH_AT,
    flushInterval: FLUSH_INTERVAL_MS,
  });
}

/**
 * Capture a named backend business event, fire-and-forget. No-op when the
 * singleton is unset (unconfigured, or initPostHog() not run — e.g. unit tests).
 * `distinctId` is the opaque DB userId surrogate (never email). Properties pass
 * through scrubDeep — the REQ-8.5 value step at the backend capture boundary —
 * and a capture throw is swallowed via the warn-storm guard so it never
 * propagates (REQ-1.4).
 */
export function captureServerEvent(
  event: string,
  opts: { distinctId: string; properties?: Record<string, string | number | boolean> },
): void {
  if (!client) return;
  try {
    client.capture({
      distinctId: opts.distinctId,
      event,
      properties: scrubDeep(opts.properties ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    logTelemetryFailureOnce('posthog', err);
  }
}

/**
 * Identify a user and set person-level properties. No-op when unconfigured.
 * PII (email, etc.) belongs here on the person profile, NOT in captureServerEvent
 * properties (REQ-8.5). Fire-and-forget; throws swallowed via the warn-storm guard.
 */
export function identifyServerUser(
  distinctId: string,
  properties: Record<string, string | boolean>,
): void {
  if (!client) return;
  try {
    client.identify({ distinctId, properties: { $set: properties } });
  } catch (err) {
    logTelemetryFailureOnce('posthog', err);
  }
}

/**
 * Redact an error before it leaves the container: run its message + stack
 * through scrubString — the shared telemetry-redact value-scrubber (masks
 * emails/secrets while keeping `file.js:line:col` frames intact via
 * VALUE_PATTERNS). A fresh Error carries the scrubbed strings; `.name` is
 * preserved so PostHog error tracking still groups by exception type. Non-Error
 * throws are scrubbed via scrubDeep. (The raw error is still logged to stdout by
 * error.middleware; stdout never leaves the container, so only this PostHog
 * capture path needs scrubbing.)
 */
function redactError(err: unknown): unknown {
  if (!(err instanceof Error)) return scrubDeep(err);
  const redacted = new Error(scrubString(err.message));
  redacted.name = err.name;
  redacted.stack = err.stack ? scrubString(err.stack) : undefined;
  return redacted;
}

/**
 * Capture an unhandled exception, REDACTED. No-op when unconfigured. `distinctId`
 * is optional — pass the authenticated userId when known, omit otherwise. The
 * error's message + stack are scrubbed (redactError) before send, so a stray
 * email/secret in an exception never reaches PostHog unmasked (REQ-8.5) — this
 * capture path must not bypass the redaction every other telemetry exit applies.
 */
export function captureServerException(err: unknown, distinctId?: string): void {
  if (!client) return;
  try {
    client.captureException(redactError(err), distinctId);
  } catch (captureErr) {
    logTelemetryFailureOnce('posthog', captureErr);
  }
}

/**
 * Flush the buffer and stop the flush timer (REQ-7). Idempotent and never
 * throws: resolves immediately when unconfigured (no client) and routes any
 * shutdown rejection through logTelemetryFailureOnce.
 */
export function shutdownPostHog(): Promise<void> {
  return client
    ? client.shutdown().catch((err) => logTelemetryFailureOnce('posthog', err))
    : Promise.resolve();
}

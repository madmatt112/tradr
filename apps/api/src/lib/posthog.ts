// PostHog backend client + explicit business-event capture (design Component 4,
// REQ-4.1/4.3/4.5, REQ-1.2/1.4, REQ-8.5). Explicit capture at service
// touch-points — NOT a generic HTTP middleware (answers design §19 Q3). When
// configured, named business events are fire-and-forget captured (no DB
// connection, never on the SSE stream path); when unconfigured it is a clean
// no-op (no client constructed — graceful absence, REQ-1.2).

import { PostHog } from 'posthog-node';

import { config, isPostHogConfigured, isPostHogPersonDeletionConfigured } from './config';
import { logger } from './logger';
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
 * The deployment label as a property bag, or undefined when POSTHOG_ENVIRONMENT
 * is unset/'' — the self-host default, where there is one deployment and nothing
 * to tell apart. Stamped at every capture exit (events, person properties,
 * exceptions) so one project can be read per-environment, and so a mis-pointed
 * key is VISIBLE rather than silently blending two deployments' data.
 */
function environmentProperties(): { environment: string } | undefined {
  const environment = config.POSTHOG_ENVIRONMENT;
  return environment ? { environment } : undefined;
}

/**
 * EVENT-level properties every backend capture carries.
 *
 * `$geoip_disable` suppresses server-side geo enrichment. The only address
 * PostHog sees on a backend event is the container's egress IP, so enrichment
 * would place every user at the host region — a wrong answer, not a missing one.
 *
 * Ingestion already applies this to server-SDK events on its own (verified: every
 * posthog-node event carried it well before this code existed). Setting it here is
 * belt-and-braces against that default changing, not a fix for a gap — an earlier
 * comment claimed posthog-node omitted it, which was wrong.
 *
 * It is an ingestion directive, not a user attribute, which is why it belongs on
 * the event and never in the person `$set` bag below.
 */
function outboundEventProperties(): Record<string, unknown> {
  return { $geoip_disable: true, ...environmentProperties() };
}

/**
 * Merge the deployment label into a property bag. Spread LAST on purpose: a
 * caller's own `environment` property is overwritten, so the label is always the
 * deploy's, never a caller's. Returns the input untouched when unconfigured — no
 * empty-object churn on the self-host path.
 */
function withEnvironment(properties: Record<string, unknown>): Record<string, unknown> {
  const stamp = environmentProperties();
  return stamp ? { ...properties, ...stamp } : properties;
}

/**
 * Capture a named backend business event, fire-and-forget. No-op when the
 * singleton is unset (unconfigured, or initPostHog() not run — e.g. unit tests).
 * `distinctId` is the opaque DB userId surrogate (never email). Properties pass
 * through scrubDeep — the REQ-8.5 value step at the backend capture boundary —
 * then pick up the deployment label — and a capture throw is swallowed via the
 * warn-storm guard so it never propagates (REQ-1.4).
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
      properties: {
        ...(scrubDeep(opts.properties ?? {}) as Record<string, unknown>),
        ...outboundEventProperties(),
      },
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
    // ONLY `$set` — the label lands on the person profile, not on the `$identify`
    // event. That is a posthog-node limitation, not a choice: identify() destructures
    // `{ $set, $set_once, $anon_distinct_id, ...rest }` and DISCARDS `rest`, so any
    // top-level property here is silently dropped before send. An earlier version
    // spread the label at the top level too; it never reached PostHog.
    //
    // Consequence: `$identify` events carry no `environment`, so filter them by the
    // PERSON property instead. Every other event (including user_logged_in, emitted
    // alongside this one) is labelled at the event level.
    client.identify({ distinctId, properties: { $set: withEnvironment(properties) } });
  } catch (err) {
    logTelemetryFailureOnce('posthog', err);
  }
}

/**
 * Best-effort delete of the PostHog person keyed by `distinctId` (the user id)
 * after an account deletion (Req 5.4, design C10). Opt-in: a clean no-op unless
 * isPostHogPersonDeletionConfigured() — the project key, a personal API key and
 * the project id must all be set. It NEVER rejects; a non-2xx response, a network
 * error, or a timeout is one warn log with the user id, so a post-commit person
 * delete can never block or reverse the deletion.
 *
 * One POST to PostHog's REST persons/bulk_delete endpoint, bounded by `timeoutMs`
 * via an AbortSignal. Pinned by a probe of PostHog's persons API reference
 * (recorded in the task 5 implementation log): the endpoint is
 * `POST {app-host}/api/projects/{project_id}/persons/bulk_delete/`, authenticated
 * with `Authorization: Bearer {personal API key}`, body `{ distinct_ids: [...] }`.
 * It lives on the APP host, NOT the ingestion `POSTHOG_HOST`
 * (`us.i.posthog.com` → `us.posthog.com`); a self-hosted host, which serves both
 * from one origin, is left unchanged.
 */
export async function deletePostHogPerson(distinctId: string, timeoutMs = 5000): Promise<void> {
  if (!isPostHogPersonDeletionConfigured()) return;

  // Rewrite the ingestion host to the app host: `*.i.posthog.com` returns 404 for
  // this management endpoint, so do not revert this to POSTHOG_HOST.
  const appHost = config.POSTHOG_HOST.replace('.i.posthog.com', '.posthog.com').replace(/\/$/, '');
  const url = `${appHost}/api/projects/${config.POSTHOG_PROJECT_ID}/persons/bulk_delete/`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.POSTHOG_PERSONAL_API_KEY}`,
      },
      body: JSON.stringify({ distinct_ids: [distinctId] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn('posthog person deletion failed', {
        userId: distinctId,
        status: response.status,
      });
    }
  } catch (err) {
    logger.warn('posthog person deletion failed', {
      userId: distinctId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
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
    client.captureException(redactError(err), distinctId, outboundEventProperties());
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

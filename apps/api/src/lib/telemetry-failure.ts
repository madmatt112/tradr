// Warn-storm rate-limit guard for telemetry sinks (REQ-1.4, design Component 12).
//
// A configured-but-failing vendor (e.g. a bad key that 401s on every event)
// must not flood the logs. This is the single guard the PostHog capture wrapper
// and the flush helper call when a telemetry call throws. It is a reliability
// guard — NOT volume/cost sampling (a named non-goal — Deferrals).
//
// State-module discipline mirrors features/advisor/idempotency-map.ts: a
// module-level constant plus module-local state, no background timer/scheduler.

import { logger } from './logger';

// At most one `warn` per surface per 5-minute window; repeats in between are
// suppressed.
export const WARN_WINDOW_MS = 5 * 60 * 1000;

// Last-logged timestamp (epoch ms) per surface. Keyed by surface so additional
// surfaces would each get their own window.
const lastLoggedAt = new Map<string, number>();

export function logTelemetryFailureOnce(surface: 'posthog', err: unknown): void {
  const now = Date.now();
  const last = lastLoggedAt.get(surface);
  if (last !== undefined && now - last < WARN_WINDOW_MS) {
    // Still inside this surface's window — suppress the repeat.
    return;
  }
  lastLoggedAt.set(surface, now);
  // Generic string reason only — the error class/message, never a vendor
  // response body.
  const error = err instanceof Error ? err.message : String(err);
  logger.warn('telemetry failure', { surface, error });
}

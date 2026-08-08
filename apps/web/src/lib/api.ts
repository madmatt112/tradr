import { eventBus } from '@/stores/event-bus.store';

declare global {
  interface Window {
    __TRADR_CONFIG__?: {
      apiBaseUrl?: string; // pre-existing
      advisorImageMaxBytes?: number; // per-image encoded-byte cap for the client pre-upload check (hosted-platform REQ-4.6); always emitted by the runtime-config seam
      posthogPublicKey?: string; // publishable phc_… project key
      posthogPublicHost?: string; // PostHog ingestion host
      posthogPublicEnvironment?: string; // deployment label stamped on every event ('production', 'staging'); absent ⇒ unstamped
      appVersion?: string; // deploy-stamped version badge (prod "v1.2.3", staging "v1.2.3-abc1234"); absent ⇒ local dev
    };
  }
}

export function resolveApiUrl(path: string): string {
  const base = (typeof window !== 'undefined' && window.__TRADR_CONFIG__?.apiBaseUrl) || '/api';
  return base + path;
}

// Deploy-stamped version string for the corner badge (components/VersionBadge).
// The deploy workflows write it into config.js; nothing writes it in local dev,
// so absence reads as 'localdev'.
export function appVersion(): string {
  return (typeof window !== 'undefined' && window.__TRADR_CONFIG__?.appVersion) || 'localdev';
}

// Whether the configured API origin differs from the page origin (split-origin).
// When `apiBaseUrl` is unset the base is the relative `/api` (same origin →
// false). Used to decide whether a credentialed cross-origin fetch of an image
// needs `crossOrigin="use-credentials"` (hosted-platform REQ-2.3): same-origin
// must NOT set it.
export function isApiCrossOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  const base = window.__TRADR_CONFIG__?.apiBaseUrl;
  if (!base) return false;
  try {
    return new URL(base, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

export let isLoggingOut = false;

export function setIsLoggingOut(value: boolean) {
  isLoggingOut = value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let router: any = null;
let redirecting = false;

// Whether this tab currently holds an authenticated session. `useAuth` is the
// only thing that knows, so it says so.
//
// IT IS WHAT TELLS A SESSION ENDING FROM AN ORDINARY 401. The interception
// below fires on any 401 that is not an explicit logout, and plenty of those
// end nothing: a logged-out visitor landing on /login runs the me-query and
// gets a 401 because there is no session, not because one just stopped. Firing
// `auth:logout` there would be noise, and — worse — burning the one-shot latch
// on it is what would leave the REAL expiry that follows with nothing to
// announce. So the announcement is gated on there having been something to end.
let hasSession = false;

/**
 * Record that a session has begun (or ended, on the explicit logout path).
 *
 * Starting one also re-arms the one-shot expiry interception. `redirecting`
 * exists to coalesce the burst of 401s a SINGLE termination produces across
 * every in-flight request — not to disable the interception for the rest of the
 * page's life. Without this reset, the logged-out me-query on a fresh /login
 * load consumes the latch and the session the user then logs into has no expiry
 * handling at all.
 */
export function setHasSession(value: boolean) {
  hasSession = value;
  if (value) redirecting = false;
}

/**
 * Announce, exactly once, that the session ended without the user asking.
 *
 * The query cache is only half of what a session owns; module-scoped client
 * state is the other half, and it survives `queryClient.clear()`. The guided
 * walkthrough keeps its session and its driver.js overlay next to its module,
 * and the onboarding funnel keeps its completion baseline next to its own, so
 * without this the next user to log in on this tab inherits both — the last
 * user's tour, and their already-done checklist items replayed as fresh
 * completions attributed to the wrong person.
 *
 * `useAuth` publishes the same event on the explicit logout path and this one
 * cannot double it: that path sets `isLoggingOut`, so its 401s never reach the
 * interception, and `hasSession` is cleared here before the event goes out.
 */
export function announceSessionExpired(): void {
  if (!hasSession) return;
  hasSession = false;
  eventBus.publish('auth:logout', {});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setRouter(r: any) {
  router = r;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    // Session cookie must ride along when apiBaseUrl is a different origin
    // (split-origin hosted deploys); fetch's same-origin default drops it.
    credentials: 'include',
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  if (opts?.signal) {
    options.signal = opts.signal;
  }

  const response = await fetch(resolveApiUrl(path), options);

  if (response.status === 401 && !isLoggingOut && !redirecting) {
    redirecting = true;
    // Before the navigation, so each owner tears its state down while the page
    // it belongs to is still on screen.
    announceSessionExpired();
    if (router) {
      router.navigate({ to: '/login', search: { expired: 'true' }, replace: true });
    } else {
      window.location.href = '/login?expired=true';
    }
    const unauthorizedError = new Error('Unauthorized') as Error & { status?: number };
    unauthorizedError.status = 401;
    throw unauthorizedError;
  }

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: 'Request failed', status: response.status }));
    if (typeof error === 'object' && error !== null) {
      (error as { status?: number }).status = response.status;
    }
    throw error;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PATCH', path, body, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

export function isUnauthorized(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: number; error?: { code?: string }; message?: string };
  return e.status === 401 || e.error?.code === 'UNAUTHORIZED' || e.message === 'Unauthorized';
}

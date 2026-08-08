import { queryClient } from '@/lib/queryClient';
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

/**
 * One-shot latch over the 401 interception below.
 *
 * It coalesces the burst of 401s a SINGLE termination produces across every
 * in-flight request, and it is also what BOUNDS the redirect: one termination
 * produces one navigation to /login, whatever 401s afterwards. That second
 * property is load-bearing — the interception navigates to /login and /login
 * navigates back to /dashboard while it still believes there is a user, so a
 * latch that re-arms on the way round is a bounce with nothing to stop it.
 *
 * ONLY A LOGIN RE-ARMS IT — `markSessionStarted`, never `markSessionConfirmed`.
 * A 200 from `GET /auth/me` was allowed to re-arm it once, and that is a cycle:
 * `announceSessionExpired` clears the query cache, the still-mounted me-query
 * refetches at once, the answer re-arms the latch, and the next 401 — from the
 * refetch storm the same clear set off — announces all over again. Only a login
 * can mean a session that did not exist a moment ago does now, so only a login
 * may re-open the interception. Everything else that legitimately re-arms it is
 * a fresh page load, which resets this module anyway.
 */
let redirecting = false;

// Whether this tab holds a session the SERVER has confirmed.
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
 * Record that the server has just confirmed an identity for this tab — a 200
 * from `GET /auth/me`, and nothing else.
 *
 * ONLY A NETWORK ANSWER MAY SET THIS, NEVER A RENDER. The first version of it
 * was driven by a `useAuth` effect over the cached user, and that is precisely
 * what made it wrong: the effect runs on every fresh mount, and expiry left a
 * stale-but-truthy user in the query cache for `/login` and `_auth` to remount
 * on. Each remount re-declared a session that had already ended, so one expiry
 * published `auth:logout` twice, and the latch above was reset on every pass of
 * the `/login` ↔ `/dashboard` bounce it exists to bound. A cache can be stale;
 * a 200 cannot.
 *
 * IT DOES NOT TOUCH THE REDIRECT LATCH. `/auth/me` answering 200 says a session
 * exists, which is not the same claim as one having just begun — and it is a
 * claim this module hears again moments after every expiry, because the clear
 * below sends the me-query straight back to the network. Re-arming on it is the
 * cycle the latch's own note describes. `markSessionStarted` is the one that
 * re-opens the interception.
 */
export function markSessionConfirmed(): void {
  hasSession = true;
}

/**
 * Record that a session has just BEGUN — a 200 from `POST /auth/login`, which is
 * the only answer that can mean there is a session where a moment ago there was
 * none.
 *
 * This is what re-arms the redirect latch, and something must: the latch
 * coalesces one termination's burst of 401s rather than disabling the
 * interception for the rest of the page's life. Without the re-arm here, the
 * logged-out me-query on a fresh /login load consumes it and the session the
 * user then logs into has no expiry handling at all.
 */
export function markSessionStarted(): void {
  hasSession = true;
  redirecting = false;
}

/**
 * Record that the session ended on the explicit logout path, where `useAuth`
 * publishes `auth:logout` itself.
 *
 * Without it, a 401 from a request that was already in flight when the user
 * logged out would be read as a second session ending and announced again.
 */
export function markSessionEnded(): void {
  hasSession = false;
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
 * interception, and it calls `markSessionEnded` for the 401s that arrive after
 * it. `hasSession` is cleared here before the event goes out, so the burst of
 * 401s one termination produces announces it once between them.
 */
export function announceSessionExpired(): void {
  if (!hasSession) return;
  hasSession = false;
  // The server state goes first, exactly as it does on `useAuth`'s logout —
  // and this is the only place that can do it for an expiry, because nothing
  // is guaranteed to be mounted here. Left alone, `['auth', 'me']` keeps the
  // departed user's row: `/login` remounts, reads it as "signed in", and sends
  // the user back to `/dashboard` over a session that no longer exists. This is
  // the same client `main.tsx` provides, so it is the same clear.
  //
  // The clear is not free, and what it costs is why `markSessionConfirmed`
  // exists: emptying the cache leaves every mounted observer holding a query
  // that no longer exists, so they all rebuild and refetch on the spot — the
  // me-query among them. Those answers used to re-open the interception, and the
  // 401s from the same burst then announced the same expiry over again, round
  // and round. They no longer do, so the burst dies out instead.
  queryClient.clear();
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

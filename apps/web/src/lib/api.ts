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

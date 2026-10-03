// Registers the hand-written service worker at `/sw.js`, production builds only,
// after first render. One pure, injectable function mirroring updateMonitor's
// MonitorDeps (apps/web/src/lib/updateMonitor.ts): every side effect is injected
// so the whole machine is testable with no real navigator, window or document.
// It never awaits `ready` and adds no `controllerchange` listener — the worker
// only keeps an offline shell fallback, and nothing reloads the page on a
// controller change (design Component 3, Requirement 2.7).

// Each dep is optional with its production default noted, so
// registerServiceWorker() with no argument is the real production construction.
export interface RegisterDeps {
  isProd?: boolean; // default import.meta.env.PROD
  container?: Pick<ServiceWorkerContainer, 'register'>; // default navigator.serviceWorker, undefined when absent
  win?: Pick<Window, 'addEventListener'>; // default window
  readyState?: () => DocumentReadyState; // default () => document.readyState
}

export function registerServiceWorker(deps: RegisterDeps = {}): void {
  const isProd = deps.isProd ?? import.meta.env.PROD;
  const container =
    deps.container ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
  const win = deps.win ?? (typeof window !== 'undefined' ? window : undefined);
  const readyState = deps.readyState ?? (() => document.readyState);

  // Dev/preview builds never register, and a browser with no service-worker
  // support continues with no error (Requirement 2.2, 2.3).
  if (!isProd || !container) return;

  const register = (): void => {
    void container.register('/sw.js', { scope: '/' }).catch(() => {
      // Swallow: a failed registration must not surface as a toast, a log or an
      // unhandled rejection (Requirement 2.3).
    });
  };

  // Wait for `load` so registration never competes with first paint; when the
  // document is already complete the listener would never fire, so register now.
  if (readyState() === 'complete') {
    register();
  } else {
    win?.addEventListener('load', register);
  }
}

import { appVersion } from '@/lib/api';
import { captureClientEvent } from '@/lib/telemetry/posthog';
import { getUpdateMonitor } from '@/lib/updateMonitor';

// The single owner of chunk-load failure recovery: the one `vite:preloadError`
// listener (installed from main.tsx before render), the one reload guard, and
// the cache-refresh-then-reload helper every error boundary calls. Nothing else
// in the tree may listen for `vite:preloadError` or touch the guard key.
//
// The reload decision itself lives in the boundary (see ChunkErrorBoundary), not
// in the listener: the listener cannot tell a user-facing chunk from a
// background import (posthog-js, the walkthrough engine), because Safari's
// message names no URL, so a listener-issued reload could reload a page for a
// telemetry import that failed. The listener therefore only tags, counts and
// nudges; the boundary that actually caught the failure decides whether to
// reload, through this module's guard and helper.

export const RELOAD_GUARD_PREFIX = 'tradr.chunk-reload.'; // + bootVersion

// The four browser/Vite wordings a vanished lazy chunk produces. The first two
// are Chromium/Firefox and Safari (the original PerformancePage pair); the last
// two are Firefox's older wording and Vite's CSS-preload failure.
export const CHUNK_LOAD_REGEX =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

// First URL-shaped token in an error message: the absolute, protocol-relative or
// root-relative `/assets/…` forms the messages carry. Safari's message carries
// none.
const EXTRACT = /(?:https?:)?\/\/\S+|\/assets\/\S+/;

const ASSET_REFRESH_TIMEOUT_MS = 5_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
type WindowLike = Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'>;

// The injectable side effects, each optional with its production default —
// mirrors updateMonitor's MonitorDeps so tests drive the whole module without a
// real DOM, storage, PostHog or reload.
export interface RecoveryDeps {
  storage?: StorageLike; // default sessionStorage
  capture?: (name: string, properties?: Record<string, string | number | boolean>) => void; // default captureClientEvent
  nudge?: () => void; // default () => getUpdateMonitor().check('chunk-failure')
  reload?: () => void; // default () => window.location.reload()
  fetch?: typeof fetch; // default window.fetch
  win?: WindowLike; // default window
}

interface ResolvedDeps {
  storage: StorageLike | undefined;
  capture: (name: string, properties?: Record<string, string | number | boolean>) => void;
  nudge: () => void;
  reload: () => void;
  fetch: typeof fetch;
  win: WindowLike | undefined;
}

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

function resolveDeps(overrides: RecoveryDeps): ResolvedDeps {
  return {
    storage: overrides.storage ?? defaultStorage(),
    capture: overrides.capture ?? captureClientEvent,
    nudge:
      overrides.nudge ??
      (() => {
        void getUpdateMonitor().check('chunk-failure');
      }),
    reload:
      overrides.reload ??
      (() => {
        window.location.reload();
      }),
    fetch:
      overrides.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
    win: overrides.win ?? (typeof window !== 'undefined' ? window : undefined),
  };
}

// Module state. `deps` starts as the production defaults so the guard and helper
// work even before install (install re-resolves them from any overrides).
let deps: ResolvedDeps = resolveDeps({});
let installed = false;
let listenerTarget: WindowLike | undefined;
// Set once a reload has been issued in this document, so a second boundary that
// fails in the same render does not reload again.
let reloadIssued = false;
// The exact Error objects Vite rethrows after `vite:preloadError`, recognised by
// identity at the boundary regardless of the browser's message wording.
let taggedErrors = new WeakSet<object>();

function guardKey(): string {
  return RELOAD_GUARD_PREFIX + appVersion();
}

function errorMessageOf(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

function errorNameOf(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name;
  }
  return 'unknown';
}

/** True when `err` is a rejected-chunk failure: tagged by the listener (identity), else matched by wording. */
export function isChunkLoadError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === 'object' && taggedErrors.has(err)) return true;
  return CHUNK_LOAD_REGEX.test(errorMessageOf(err));
}

// Whether a reload would be permitted right now, WITHOUT consuming the guard —
// used by the listener's event capture so reporting never spends the one reload.
function guardPermits(): boolean {
  if (reloadIssued) return false;
  const storage = deps.storage;
  if (!storage) return false;
  try {
    return storage.getItem(guardKey()) === null;
  } catch {
    return false;
  }
}

/**
 * Consume the one-reload guard. Returns true at most once per boot version per
 * tab (the key survives the reload, is gone with the tab); false if a reload was
 * already issued in this document, if the guard was already spent, or — the
 * Safari-private-mode case — if storage throws. A storage failure degrades to
 * NOT reloading, never to reloading unguarded.
 */
export function attemptAutomaticReload(): boolean {
  if (reloadIssued) return false;
  const storage = deps.storage;
  if (!storage) return false;
  const key = guardKey();
  try {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, String(Date.now()));
  } catch {
    return false;
  }
  reloadIssued = true;
  return true;
}

async function refreshAsset(href: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_REFRESH_TIMEOUT_MS);
  try {
    await deps.fetch(href, { cache: 'reload', credentials: 'omit', signal: controller.signal });
  } catch {
    // Every outcome is swallowed — a failed refresh must not stop the reload.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recover from a chunk failure: replace the failed asset's cached entry from the
 * network (so a 404/shell answered during the deploy-propagation window is not
 * pinned for a year by the immutable cache), then reload. The refresh runs ONLY
 * for a validated same-origin `/assets/…` URL — a foreign or protocol-relative
 * URL from the (browser-supplied, untrusted) message is never fetched, and the
 * helper falls straight through to a plain reload. Used by both the automatic
 * path and every fallback's manual Reload button.
 */
export async function reloadAfterChunkFailure(err: unknown): Promise<void> {
  const win = deps.win;
  const origin = win?.location.origin;
  const match = origin ? EXTRACT.exec(errorMessageOf(err))?.[0] : undefined;
  if (match && origin) {
    try {
      const u = new URL(match, origin);
      if (u.origin === origin && u.pathname.startsWith('/assets/')) {
        await refreshAsset(u.href);
      }
    } catch {
      // Unparseable URL — fall through to a plain reload.
    }
  }
  deps.reload();
}

function onPreloadError(event: Event): void {
  const payload: unknown = (event as { payload?: unknown }).payload;
  if (payload && typeof payload === 'object') taggedErrors.add(payload);
  const servedVersion = getUpdateMonitor().getSnapshot().servedVersion ?? 'unknown';
  deps.capture('chunk_load_failed', {
    bootVersion: appVersion(),
    servedVersion,
    reloadPermitted: guardPermits(),
    errorName: errorNameOf(payload),
  });
  // A vanished chunk is the strongest evidence of a deploy this client can get.
  // The nudge is a no-op unless the monitor is still polling, so it can never
  // re-poll or re-broadcast once an update is already known.
  deps.nudge();
  // Deliberately NO event.preventDefault(): with the default prevented, Vite's
  // helper resolves the import to `undefined` and React.lazy throws an unrelated
  // TypeError that no boundary can classify. Left in place, the tagged original
  // error reaches the boundary, which renders the stated failure.
}

function pruneStaleGuardKeys(): void {
  const storage = deps.storage;
  if (!storage) return;
  const current = guardKey();
  try {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(RELOAD_GUARD_PREFIX) && key !== current) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // Best effort — a storage that throws just keeps its keys.
  }
}

function uninstall(): void {
  if (!installed) return;
  listenerTarget?.removeEventListener('vite:preloadError', onPreloadError as EventListener);
  installed = false;
  listenerTarget = undefined;
}

/**
 * Register the single `vite:preloadError` listener and prune stale guard keys.
 * Idempotent — a second call re-resolves deps but never adds a second listener.
 * Returns an uninstall function (used by tests).
 */
export function installChunkRecovery(overrides: RecoveryDeps = {}): () => void {
  const wasInstalled = installed;
  deps = resolveDeps(overrides);
  if (!wasInstalled) {
    listenerTarget = deps.win;
    listenerTarget?.addEventListener('vite:preloadError', onPreloadError as EventListener);
    installed = true;
  }
  pruneStaleGuardKeys();
  return uninstall;
}

/** Test seam — removes the listener and resets module-local state. */
export function __resetChunkRecoveryForTests(): void {
  uninstall();
  deps = resolveDeps({});
  reloadIssued = false;
  taggedErrors = new WeakSet<object>();
}

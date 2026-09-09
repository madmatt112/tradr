import { appVersion, LOCALDEV } from '@/lib/api';

// One pure, injectable module that owns update detection: it knows the boot
// version (what the running bundle loaded with), fetches the version currently
// being served from the SPA's own origin, compares by inequality, runs the
// visibility-scoped schedule, and shares "an update exists" across same-origin
// tabs. Every side effect is injected through MonitorDeps so the whole machine
// is testable with fake timers and no DOM beyond jsdom.

export const CHECK_INTERVAL_MS = 5 * 60_000; // visible-tab poll
export const MIN_CHECK_SPACING_MS = 30_000; // collapses focus + visibility + route bursts
export const FETCH_TIMEOUT_MS = 10_000;
export const UPDATE_CHANNEL = 'tradr-update';
export const VERSION_SHAPE = /^[A-Za-z0-9.+-]{1,64}$/; // charset+length gate

// Minimal structural router type — only the subscription the monitor uses.
export type RouterLike = { subscribe(event: 'onResolved', cb: () => void): () => void };

// Every side effect is injected; each is optional with the production default
// noted, so createUpdateMonitor() with no argument is the real production
// construction.
export interface MonitorDeps {
  bootVersion?: string; // default appVersion()
  fetchServed?: () => Promise<string | undefined>; // default fetchServedVersion
  now?: () => number; // default Date.now
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>; // default document
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>; // default window
  channel?: () => BroadcastChannel | undefined; // default guarded new BroadcastChannel(UPDATE_CHANNEL)
  reload?: () => void; // default () => window.location.reload()
}

export type CheckReason = 'interval' | 'visible' | 'focus' | 'navigation' | 'chunk-failure';
export type MonitorPhase = 'idle' | 'inert' | 'polling' | 'update-available';

export interface MonitorSnapshot {
  phase: MonitorPhase;
  bootVersion: string;
  servedVersion?: string; // set iff phase === 'update-available'
  learnedVia?: 'poll' | 'broadcast';
  promptVisible: boolean; // update-available && dismissedVersion !== servedVersion
}

export interface UpdateMonitor {
  start(opts?: { router?: RouterLike }): void; // idempotent; attaches the router + registers onResolved
  stop(): void;
  check(reason: CheckReason): Promise<void>; // fetches only while phase is 'polling'; idle / inert / update-available ⇒ no-op
  dismiss(): void; // tab-local, for the current servedVersion only
  accept(): void; // captures nothing itself; UpdatePrompt captures, then calls this
  subscribe(listener: () => void): () => void;
  getSnapshot(): MonitorSnapshot; // referentially stable until state changes
}

// The captured token is the whole quoted string (quotes included), so JSON.parse
// honours whatever `json_str` escaped in the entrypoint's output.
const APP_VERSION_TOKEN = /"appVersion"\s*:\s*("(?:[^"\\]|\\.)*")/;

/**
 * Pull the served version out of the `/config.js` text: the quoted `appVersion`
 * token, decoded with JSON.parse, then charset+length gated. Anything else — no
 * match, a JSON.parse throw, a non-string, an empty value, a value longer than
 * 64 chars, or any character outside `[A-Za-z0-9.+-]` — is `undefined`, so a
 * mis-generated or hostile value can never reach the prompt or an event.
 */
export function parseServedVersion(configJsText: string): string | undefined {
  const match = APP_VERSION_TOKEN.exec(configJsText);
  if (!match) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  return VERSION_SHAPE.test(value) ? value : undefined;
}

/**
 * Fetch `/config.js` from the SPA origin and return the parsed served version,
 * or `undefined` for any "unknown" outcome (non-2xx, network error, abort,
 * unparseable, absent field). Root-relative on purpose — never through
 * resolveApiUrl, which points at the API origin on split-origin deploys.
 * `cache: 'no-store'` bypasses the HTTP cache (and any service-worker cache that
 * honours request cache modes), so detection is never satisfiable from a cache.
 */
export async function fetchServedVersion(deps?: {
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const doFetch = deps?.fetch ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch('/config.js', {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return parseServedVersion(await response.text());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function defaultChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  try {
    return new BroadcastChannel(UPDATE_CHANNEL);
  } catch {
    return undefined;
  }
}

interface UpdateMessage {
  type: 'update-available';
  servedVersion: string;
}

export function createUpdateMonitor(deps: MonitorDeps = {}): UpdateMonitor {
  const bootVersion = deps.bootVersion ?? appVersion();
  const fetchServed = deps.fetchServed ?? fetchServedVersion;
  const now = deps.now ?? Date.now;
  const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const win = deps.win ?? (typeof window !== 'undefined' ? window : undefined);
  const makeChannel = deps.channel ?? defaultChannel;
  const reload =
    deps.reload ??
    (() => {
      window.location.reload();
    });

  // LOCALDEV boot ⇒ permanently inert: nothing to compare a fetched version
  // against, so start()/check() never register or fetch anything.
  let phase: MonitorPhase = bootVersion === LOCALDEV ? 'inert' : 'idle';
  let servedVersion: string | undefined;
  let learnedVia: 'poll' | 'broadcast' | undefined;
  let dismissedVersion: string | undefined;
  let router: RouterLike | undefined;

  let intervalId: ReturnType<typeof setInterval> | undefined;
  let lastCheckAt = now(); // boot counts as a check at t = 0
  let checking = false;

  let channel: BroadcastChannel | undefined;
  let channelListener: ((ev: MessageEvent) => void) | undefined;
  // Listeners torn down when polling stops (on update-available and on stop):
  // the interval, visibilitychange, focus, and the router's onResolved. The
  // channel is NOT among them — it stays open in update-available so this tab
  // can still hear about a *second* deploy.
  const pollingCleanups: Array<() => void> = [];
  let routerUnsub: (() => void) | undefined;

  const listeners = new Set<() => void>();

  function computeSnapshot(): MonitorSnapshot {
    return {
      phase,
      bootVersion,
      servedVersion,
      learnedVia,
      promptVisible: phase === 'update-available' && dismissedVersion !== servedVersion,
    };
  }

  // Recomputed only here, so getSnapshot() is referentially stable until state
  // actually changes (useSyncExternalStore compares with Object.is).
  let snapshot: MonitorSnapshot = computeSnapshot();

  function emit(): void {
    snapshot = computeSnapshot();
    for (const listener of Array.from(listeners)) listener();
  }

  function isVisible(): boolean {
    return doc?.visibilityState === 'visible';
  }

  function startInterval(): void {
    if (intervalId !== undefined) return;
    intervalId = setInterval(() => {
      void check('interval');
    }, CHECK_INTERVAL_MS);
  }

  function clearIntervalTimer(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  }

  function subscribeRouter(): void {
    if (!router || routerUnsub) return;
    routerUnsub = router.subscribe('onResolved', () => {
      void check('navigation');
    });
  }

  function removePollingListeners(): void {
    clearIntervalTimer();
    for (const cleanup of pollingCleanups.splice(0)) cleanup();
    if (routerUnsub) {
      routerUnsub();
      routerUnsub = undefined;
    }
  }

  function openChannel(): void {
    if (channel) return;
    channel = makeChannel();
    if (!channel) return;
    channelListener = (ev: MessageEvent) => {
      onChannelMessage(ev);
    };
    channel.addEventListener('message', channelListener);
  }

  function closeChannel(): void {
    if (!channel) return;
    if (channelListener) channel.removeEventListener('message', channelListener);
    try {
      channel.close();
    } catch {
      // Already closed / unavailable — nothing to do.
    }
    channel = undefined;
    channelListener = undefined;
  }

  function postUpdate(served: string): void {
    const message: UpdateMessage = { type: 'update-available', servedVersion: served };
    try {
      channel?.postMessage(message);
    } catch {
      // Channel unavailable/closed — other tabs fall back to independent polling.
    }
  }

  function enterUpdateAvailable(served: string, via: 'poll' | 'broadcast'): void {
    phase = 'update-available';
    servedVersion = served;
    learnedVia = via;
    // Polling stops the moment the answer is known (REQ-2.5).
    removePollingListeners();
    // Only a locally-detected update is broadcast; an inbound message is never
    // re-broadcast, so there are no message storms.
    if (via === 'poll') postUpdate(served);
    emit();
  }

  function onChannelMessage(ev: MessageEvent): void {
    const data: unknown = ev.data;
    if (typeof data !== 'object' || data === null) return;
    if ((data as { type?: unknown }).type !== 'update-available') return;
    const served = (data as { servedVersion?: unknown }).servedVersion;
    if (typeof served !== 'string' || !VERSION_SHAPE.test(served)) return;
    // A tab that already reloaded onto the served version must not prompt itself.
    if (served === bootVersion) return;
    if (phase !== 'polling' && phase !== 'update-available') return;
    // Already knew this exact version — no change, no re-broadcast.
    if (phase === 'update-available' && served === servedVersion) return;
    // A different served version replaces the known one; because dismissal is
    // keyed to the served version, the prompt re-arms after a prior dismissal.
    enterUpdateAvailable(served, 'broadcast');
  }

  function onVisibilityChange(): void {
    if (phase !== 'polling') return;
    if (isVisible()) {
      startInterval();
      void check('visible');
    } else {
      clearIntervalTimer();
    }
  }

  async function check(reason: CheckReason): Promise<void> {
    // No-op in idle, inert and update-available: fetches only while polling.
    if (phase !== 'polling') return;
    // Never overlap an in-flight check.
    if (checking) return;
    const t = now();
    // 30 s spacing collapses focus/visibility/route bursts; chunk-failure is the
    // one reason exempt from spacing (but not from the phase gate above).
    if (reason !== 'chunk-failure' && t - lastCheckAt < MIN_CHECK_SPACING_MS) return;
    lastCheckAt = t;
    checking = true;
    try {
      const served = await fetchServed();
      // Unknown outcome, or state changed while awaiting (a broadcast arrived).
      if (served === undefined || phase !== 'polling') return;
      if (served !== bootVersion) enterUpdateAvailable(served, 'poll');
    } finally {
      checking = false;
    }
  }

  function start(opts?: { router?: RouterLike }): void {
    if (opts?.router) router = opts.router;
    if (phase !== 'idle') {
      // Idempotent (StrictMode calls start twice). If we are already polling and
      // a router has since been supplied, register its navigation trigger now.
      if (phase === 'polling') subscribeRouter();
      return;
    }
    phase = 'polling';
    openChannel();
    if (doc) {
      const onVisibility = () => onVisibilityChange();
      doc.addEventListener('visibilitychange', onVisibility);
      pollingCleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility));
    }
    if (win) {
      const onFocus = () => {
        void check('focus');
      };
      win.addEventListener('focus', onFocus);
      pollingCleanups.push(() => win.removeEventListener('focus', onFocus));
    }
    subscribeRouter();
    // The interval runs only while the tab is visible.
    if (isVisible()) startInterval();
    emit();
  }

  function stop(): void {
    removePollingListeners();
    closeChannel();
    router = undefined;
    // A known update survives (the answer does not un-happen); an inert monitor
    // stays inert. Only a live poller resets to idle so a later start() re-arms.
    if (phase === 'polling') phase = 'idle';
    emit();
  }

  function dismiss(): void {
    if (phase !== 'update-available') return;
    // Tab-local and keyed to the served version; never broadcast.
    dismissedVersion = servedVersion;
    emit();
  }

  function accept(): void {
    reload();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): MonitorSnapshot {
    return snapshot;
  }

  return { start, stop, check, dismiss, accept, subscribe, getSnapshot };
}

let singleton: UpdateMonitor | undefined;

/**
 * The app-wide monitor, created lazily with production defaults and **no
 * router**. Both callers — UpdatePrompt (which supplies the router through
 * start({ router })) and the chunk-recovery nudge — reach the same instance.
 */
export function getUpdateMonitor(): UpdateMonitor {
  if (!singleton) singleton = createUpdateMonitor();
  return singleton;
}

/** Test seam — tears down and forgets the singleton so runs are isolated. */
export function __resetUpdateMonitorForTests(): void {
  if (singleton) singleton.stop();
  singleton = undefined;
}

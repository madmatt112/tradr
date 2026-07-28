if (typeof globalThis.crypto?.subtle === 'undefined') {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
}

// jsdom v29 does NOT implement matchMedia. next-themes calls it on mount.
if (typeof globalThis.window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// jsdom v29 does NOT implement BroadcastChannel. Node 18+ provides a global
// BroadcastChannel (worker_threads) whose dispatchEvent rejects jsdom's MessageEvent
// (cross-realm Event class identity). Unconditionally override with a stub so the
// hook can post + tests can dispatch synthetic inbound messages. (Task 25 tests only
// the SEND side; cross-tab DELIVERY is covered by the E2E test in Task 49.)
{
  // NOTE: Implement add/removeEventListener manually rather than extending Node's
  // EventTarget — Node's EventTarget rejects jsdom's MessageEvent (cross-realm class
  // identity), which prevents tests from dispatching synthetic inbound messages.
  class BroadcastChannelStub {
    readonly name: string;
    onmessage: ((ev: MessageEvent) => unknown) | null = null;
    onmessageerror: ((ev: MessageEvent) => unknown) | null = null;
    private readonly listeners: Map<string, Set<(ev: Event) => void>> = new Map();
    constructor(name: string) {
      this.name = name;
    }
    addEventListener(type: string, fn: (ev: Event) => void): void {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(fn);
    }
    removeEventListener(type: string, fn: (ev: Event) => void): void {
      this.listeners.get(type)?.delete(fn);
    }
    dispatchEvent(ev: Event): boolean {
      const set = this.listeners.get(ev.type);
      if (set) {
        for (const fn of Array.from(set)) {
          fn(ev);
        }
      }
      if (ev.type === 'message' && this.onmessage) {
        this.onmessage(ev as MessageEvent);
      }
      return true;
    }
    postMessage(_data: unknown): void {
      void _data;
    }
    close(): void {
      this.listeners.clear();
    }
  }
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    value: BroadcastChannelStub,
    writable: true,
    configurable: true,
  });
}

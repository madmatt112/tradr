import { useEffect } from 'react';

import type { EventName, EventPayloads } from './events.types';

type Handler<E extends EventName> = (payload: EventPayloads[E]) => void;

const subscribers: Map<EventName, Set<Handler<EventName>>> = new Map();

function subscribe<E extends EventName>(event: E, handler: Handler<E>): () => void {
  let set = subscribers.get(event);
  if (!set) {
    set = new Set();
    subscribers.set(event, set);
  }
  const erased = handler as Handler<EventName>;
  set.add(erased);
  return () => {
    const current = subscribers.get(event);
    if (!current) return;
    current.delete(erased);
    if (current.size === 0) {
      subscribers.delete(event);
    }
  };
}

function publish<E extends EventName>(event: E, payload: EventPayloads[E]): void {
  const set = subscribers.get(event);
  if (!set) return;
  // Snapshot to avoid mutation during iteration (§Z-r4 reentrancy).
  const snapshot = [...set];
  for (const handler of snapshot) {
    try {
      (handler as Handler<E>)(payload);
    } catch (err) {
      // Per-handler isolation (§Z-r4 error isolation).
      console.error(`[event-bus] handler for "${event}" threw:`, err);
    }
  }
}

function __resetForTests(): void {
  subscribers.clear();
}

export const eventBus = {
  subscribe,
  publish,
  __resetForTests,
};

export function useEventBusSubscribe<E extends EventName>(
  event: E,
  handler: Handler<E>,
): void {
  useEffect(() => {
    const unsubscribe = eventBus.subscribe(event, handler);
    return unsubscribe;
  }, [event, handler]);
}

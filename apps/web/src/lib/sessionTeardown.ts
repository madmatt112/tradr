import type { QueryClient } from '@tanstack/react-query';

import { queryClient as singletonQueryClient } from '@/lib/queryClient';
import { DRAWER_STORAGE_KEY, useDrawerStore } from '@/stores/drawer.store';
import { eventBus } from '@/stores/event-bus.store';

/**
 * Drop everything on this tab that belonged to the session that just stopped
 * being the current one.
 *
 * THERE IS ONE OF THESE, AND ALL FOUR PATHS CALL IT. A session stops being
 * current in four ways — the user logs out, it expires under them, someone else
 * logs in on the same tab, or someone else REGISTERS on it — and the state that
 * has to go is the same state every time. Two of those paths used to carry
 * their own copy of the teardown and had already drifted apart (only the logout
 * one dropped the drawer key), and the other two did no teardown at all:
 * `/login` and `/register` no longer bounce an authenticated visitor away, so a
 * signed-in user can reach either form and become somebody else, and without
 * this the second user inherited the first one's cached rows.
 *
 * Three kinds of state, because clearing the query cache only reaches the
 * first:
 *  - SERVER state — the query cache, `['auth','me']` among it.
 *  - STORED state — `tradr_drawer_state` in localStorage, which is global
 *    rather than per-user, AND the live `useDrawerStore` it seeded. Both, or
 *    neither: the store hydrates from that key once at module import, and a
 *    login is a client-side navigation rather than a page load, so dropping the
 *    key alone leaves the departing user's drawer on screen for the arriving
 *    one — who then persists it back on their first change.
 *  - MODULE state — the guided walkthrough's session and its driver.js
 *    overlay, the onboarding funnel's completion baseline. Each owner drops
 *    its own on `auth:logout`; announcing it rather than importing them keeps
 *    auth from depending on the features that listen.
 *
 * Order is load-bearing: the cache goes before the announcement, so a listener
 * that reads it sees it already empty.
 *
 * It says nothing about whether a session is live — `lib/api`'s `hasSession`
 * flag and the redirect latch stay with their callers, which are the ones that
 * know which of the four cases this is.
 */
export function clearClientSessionState(client: QueryClient = singletonQueryClient): void {
  // The LIVE store before the stored key, and that order is load-bearing:
  // SideDrawer subscribes to the store and persists every change it sees, so on
  // a logout — the one path where the drawer is still on screen — the reset
  // writes the defaults straight back into the key. Removing the key second
  // means that write has already happened and the key still ends up gone.
  useDrawerStore.getState().reset();
  try {
    localStorage.removeItem(DRAWER_STORAGE_KEY);
  } catch {
    /* swallow — storage may be unavailable (private mode, no DOM) */
  }
  client.clear();
  eventBus.publish('auth:logout', {});
}

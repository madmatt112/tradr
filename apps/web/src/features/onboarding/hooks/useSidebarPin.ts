// useSidebarPin — the nav rail's pin preference (expanded vs icon rail).
//
// The server record (`users.onboarding.sidebarPinned`, via the ordinary
// onboarding preference channel) is the source of truth: it is what makes the
// pin survive re-login and follow the user across devices. localStorage keeps
// a DEVICE MIRROR beside it, for one reason only: the preference read is a
// round trip, and without a local first guess every page load would paint the
// icon rail and then jump to the pinned width for pinned users. The mirror is
// never authoritative — the server value overwrites it the moment the query
// lands.
//
// SEEDING. The pre-redesign sidebar stored `sidebar-collapsed` in localStorage
// and nowhere else. When the server has never seen a preference
// (`sidebarPinned` absent) and that legacy key exists, its inverse is written
// through the normal PATCH once, and the legacy key is removed — the one-time
// migration the schema's "optional without a default" exists to allow.

import { useCallback, useEffect, useState } from 'react';

import { useOnboardingPatch, useOnboardingQuery } from './useOnboarding';

export const SIDEBAR_PIN_MIRROR_KEY = 'sidebar-pinned';
export const LEGACY_COLLAPSED_KEY = 'sidebar-collapsed';

function readMirror(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_PIN_MIRROR_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeMirror(value: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_PIN_MIRROR_KEY, String(value));
  } catch {
    /* private mode — the server record still persists the preference */
  }
}

export function useSidebarPin(): { pinned: boolean; setPinned: (next: boolean) => void } {
  const query = useOnboardingQuery();
  const patch = useOnboardingPatch();
  const patchMutate = patch.mutate;

  const [pinned, setPinnedLocal] = useState<boolean>(readMirror);

  useEffect(() => {
    if (!query.data) return;
    const server = query.data.sidebarPinned;
    if (server !== undefined) {
      // The server record wins; keep the device mirror in step with it.
      setPinnedLocal(server);
      writeMirror(server);
      return;
    }
    // Never expressed server-side: seed once from the legacy localStorage key
    // if the pre-redesign sidebar left one (`collapsed: true` ⇒ unpinned).
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem(LEGACY_COLLAPSED_KEY);
    } catch {
      return;
    }
    if (legacy !== null) {
      const seeded = legacy !== 'true';
      setPinnedLocal(seeded);
      writeMirror(seeded);
      try {
        localStorage.removeItem(LEGACY_COLLAPSED_KEY);
      } catch {
        /* ignore */
      }
      patchMutate({ sidebarPinned: seeded });
    }
  }, [query.data, patchMutate]);

  const setPinned = useCallback(
    (next: boolean) => {
      setPinnedLocal(next);
      writeMirror(next);
      patchMutate({ sidebarPinned: next });
    },
    [patchMutate],
  );

  return { pinned, setPinned };
}

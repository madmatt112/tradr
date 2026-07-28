import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { THEME_PUT_FAILURE_TOMBSTONE_MS } from '@/features/dashboard/grid.constants';
import { useDashboardLayout } from '@/features/dashboard/hooks/useDashboardLayout';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';

type ThemeValue = 'light' | 'dark' | 'system';

// §C / §C-r3: tombstone lives in sessionStorage, so a full page reload preserves the
// 60s failure window. Tab-close-and-reopen does NOT (sessionStorage is per-tab).
// writeTombstone is wrapped in try/catch (Safari Private Browsing throws on setItem).
const TOMBSTONE_KEY = 'tradr_theme_pending';
type Tombstone = {
  lastPendingAt: number;
  lastFailedAt: number;
  pendingTheme: ThemeValue | null;
  didBoot: boolean;
};
function readTombstone(): Tombstone {
  try {
    return (
      JSON.parse(sessionStorage.getItem(TOMBSTONE_KEY) ?? 'null') ?? {
        lastPendingAt: 0,
        lastFailedAt: 0,
        pendingTheme: null,
        didBoot: false,
      }
    );
  } catch {
    return { lastPendingAt: 0, lastFailedAt: 0, pendingTheme: null, didBoot: false };
  }
}
function writeTombstone(patch: Partial<Tombstone>): void {
  try {
    sessionStorage.setItem(TOMBSTONE_KEY, JSON.stringify({ ...readTombstone(), ...patch }));
  } catch {
    // §C-r3: Safari Private Browsing throws on setItem; the tombstone is best-effort.
    // We accept that in private mode the boot-skip-on-failure window may not apply.
  }
}

// §K-r4: lastBroadcastTs is held in a ref inside useCrossTabThemeSync to avoid
// module-level mutable state that breaks test isolation.

// §O: module-level guard so a React StrictMode double-mount does not double-POST
// (a single boot per page-load).
let didBootForReact = false;

function resolveEffective(
  theme: string | undefined,
  systemTheme: string | undefined,
): ThemeValue {
  if (theme === 'system') return ((systemTheme as ThemeValue | undefined) ?? 'light');
  return ((theme as ThemeValue | undefined) ?? 'system');
}

function useBootThemeReconciliation(nextThemeSetTheme: (t: string) => void): void {
  const { user } = useAuth();
  useEffect(() => {
    if (user == null) return;
    if (didBootForReact) return;
    const tomb = readTombstone();
    if (tomb.didBoot) return;
    didBootForReact = true;
    let cancelled = false;
    (async () => {
      try {
        await api.post('/dashboard/theme-cookie');
        const server = await api.get<{ theme: ThemeValue }>('/dashboard/theme');
        if (cancelled) return;
        const latest = readTombstone();
        const skip =
          latest.lastPendingAt > 0 ||
          Date.now() - latest.lastFailedAt < THEME_PUT_FAILURE_TOMBSTONE_MS;
        if (!skip) {
          nextThemeSetTheme(server.theme);
        }
        writeTombstone({ didBoot: true });
      } catch {
        // Boot reconciliation failures are non-fatal; user keeps their local theme.
        writeTombstone({ didBoot: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, nextThemeSetTheme]);
}

// §K-r4: broadcast helper. The hook owns the channel + lastBroadcastTs ref; the helper
// is invoked through a stable callback that closes over the ref.
function makeBroadcastTheme(
  channelRef: React.MutableRefObject<BroadcastChannel | null>,
  lastBroadcastTsRef: React.MutableRefObject<number>,
): (value: ThemeValue, userId: string | undefined) => void {
  return (value, userId) => {
    if (!userId) return;
    const ts = Date.now();
    lastBroadcastTsRef.current = ts;
    try {
      channelRef.current?.postMessage({ value, userId, ts });
    } catch {
      // BroadcastChannel unavailable / closed — storage-event fallback covers most browsers.
    }
  };
}

function useCrossTabThemeSync(
  nextThemeSetTheme: (t: string) => void,
  userId: string | undefined,
): {
  channelRef: React.MutableRefObject<BroadcastChannel | null>;
  lastBroadcastTsRef: React.MutableRefObject<number>;
} {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const channelRef = useRef<BroadcastChannel | null>(null);
  const lastBroadcastTsRef = useRef<number>(0);

  // Keep the latest user/userId visible to the listener without recreating the channel.
  const userRef = useRef(user);
  userRef.current = user;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('tradr-theme');
    channelRef.current = channel;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | { value: ThemeValue; userId: string; ts: number }
        | null
        | undefined;
      if (!data) return;
      // §K-r4 #1: ignore if auth-null (post-logout safety — don't re-create cache after clear()).
      if (userRef.current == null) return;
      // §K-r4 #2: ignore cross-account messages.
      if (data.userId !== userIdRef.current) return;
      // §K-r4 #3: echo suppression.
      if (Math.abs(data.ts - lastBroadcastTsRef.current) < 200) return;
      // §K-r4 #4: stale messages (e.g., queued in a backgrounded tab).
      if (Date.now() - data.ts > 5_000) return;
      nextThemeSetTheme(data.value);
      queryClient.setQueryData(['users', 'me', 'theme'], { theme: data.value });
    };
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
      channelRef.current = null;
    };
  }, [nextThemeSetTheme, queryClient]);

  // Storage-event fallback for browsers without BroadcastChannel (or in addition to it).
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'theme') return;
      // §K-r4: storage events don't carry userId, so skip if unauthenticated to avoid
      // cross-account interleaves after a logout/login on the same machine.
      if (userRef.current == null) return;
      const newValue = event.newValue as ThemeValue | null;
      if (!newValue) return;
      nextThemeSetTheme(newValue);
      queryClient.setQueryData(['users', 'me', 'theme'], { theme: newValue });
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [nextThemeSetTheme, queryClient]);

  return { channelRef, lastBroadcastTsRef };
}

export function useAppTheme() {
  const queryClient = useQueryClient();
  const nextTheme = useTheme();
  const { user } = useAuth();
  const layout = useDashboardLayout(); // §D-r3: theme PUT goes through this hook

  const { data: cached } = useQuery({
    queryKey: ['users', 'me', 'theme'],
    queryFn: () => api.get<{ theme: ThemeValue }>('/dashboard/theme'),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });

  useBootThemeReconciliation(nextTheme.setTheme);
  const { channelRef, lastBroadcastTsRef } = useCrossTabThemeSync(
    nextTheme.setTheme,
    user?.id,
  );

  const broadcastTheme = useCallback(
    (value: ThemeValue, userId: string | undefined) =>
      makeBroadcastTheme(channelRef, lastBroadcastTsRef)(value, userId),
    [channelRef, lastBroadcastTsRef],
  );

  const setTheme = useCallback(
    async (t: ThemeValue) => {
      nextTheme.setTheme(t);
      writeTombstone({ lastPendingAt: Date.now(), pendingTheme: t });
      try {
        // §D-r3: route through useDashboardLayout's mutation so layout-PUTs and theme-PUTs
        // serialize under scope: { id: 'dashboard-layout' }.
        const response = await layout.putTheme(t);
        queryClient.setQueryData(['users', 'me', 'theme'], { theme: response.theme });
        // (layout cache already updated by useDashboardLayout.onSuccess per §J-r3)
        writeTombstone({ lastPendingAt: 0, pendingTheme: null });
        broadcastTheme(response.theme as ThemeValue, user?.id); // §K-r3/r4
      } catch {
        writeTombstone({ lastFailedAt: Date.now(), lastPendingAt: 0 });
        toast.error("Couldn't sync theme. Retry?", {
          action: { label: 'Retry', onClick: () => setTheme(t) },
        });
        // Local change is NOT reverted (§C-requirements).
      }
    },
    [nextTheme, queryClient, layout, user?.id, broadcastTheme],
  );

  return {
    theme: (cached?.theme ?? nextTheme.theme ?? 'system') as ThemeValue,
    effectiveTheme: resolveEffective(nextTheme.theme, nextTheme.systemTheme),
    setTheme,
  };
}

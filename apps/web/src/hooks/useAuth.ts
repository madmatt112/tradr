import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

import type { User } from '@tradr/shared';

import {
  api,
  markSessionConfirmed,
  markSessionEnded,
  markSessionStarted,
  setIsLoggingOut,
} from '@/lib/api';
import { DRAWER_STORAGE_KEY } from '@/stores/drawer.store';
import { eventBus } from '@/stores/event-bus.store';

/**
 * The login mutation ALONE, without the `['auth','me']` query `useAuth` mounts
 * beside it.
 *
 * SF-3: /login is a public page, and a public page that mounts the me-query
 * redirects itself away. A cold load has no session, so `GET /auth/me` answers
 * 401 and `lib/api`'s global interception navigates to `/login?expired=true` —
 * which on /login itself is a session-expired notice shown to a visitor who
 * never had a session. The page that BEGINS a session may therefore only ask to
 * begin one; it must not also ask whether one already exists.
 *
 * routes/__tests__/public-routes-cold-load.test.tsx enforces this.
 */
export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (credentials: { email: string; password: string }) =>
      api.post<{ user: User }>('/auth/login', credentials),
    onSuccess: (data) => {
      // The one answer that means a session BEGAN rather than merely exists, so
      // this is where the 401 interception is re-armed. Seeding the query below
      // means its `queryFn` may not run again for this session, so the session
      // start is declared from the answer that established it.
      markSessionStarted();
      queryClient.setQueryData(['auth', 'me'], data.user);
    },
  });
}

export function useAuth() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: user, isLoading } = useQuery<User>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      const me = await api.get<User>('/auth/me');
      // `lib/api` intercepts 401s, and it cannot tell one that ENDED a session
      // from the one a logged-out visitor's me-query returns on the login page.
      // This request is what tells it apart, and the answer to it is the only
      // honest evidence there is: the server has just named the user, so there
      // is a session, right now. Declared HERE rather than from an effect over
      // `user` — an effect fires on every mount, including the ones that read a
      // cached user belonging to a session that has already ended.
      //
      // CONFIRMED, not started: this answer says a session exists, not that one
      // has just begun, and the difference is what the redirect latch turns on.
      // An expiry clears the cache, which sends this very query back to the
      // network, and re-arming the latch on what comes back is what turned one
      // expiry into a loop of them. The login below is the one that re-arms.
      markSessionConfirmed();
      return me;
    },
    retry: false,
  });

  const loginMutation = useLogin();

  const logoutMutation = useMutation({
    mutationFn: async () => {
      setIsLoggingOut(true);
      return api.post('/auth/logout');
    },
    onSettled: () => {
      setIsLoggingOut(false);
      // The session is over on this path too, so a later 401 must not be read
      // as a second one ending — this one already published below.
      markSessionEnded();
      try {
        localStorage.removeItem(DRAWER_STORAGE_KEY);
      } catch {
        /* swallow */
      }
      queryClient.clear();
      // Clearing the query cache only drops SERVER state. Module-scoped client
      // state outlives it — the guided walkthrough keeps its session, and its
      // driver.js overlay, next to the module rather than in a component — and
      // the next user to log in on this tab would inherit it. Announcing the
      // logout lets each owner tear its own down; a direct import from here
      // into the onboarding feature would couple auth to it and invite a cycle.
      eventBus.publish('auth:logout', {});
      router.navigate({ to: '/login' });
    },
  });

  return {
    user: user ?? null,
    isLoading,
    isAuthenticated: !!user,
    login: loginMutation,
    logout: logoutMutation,
  };
}

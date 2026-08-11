import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

import type { User } from '@tradr/shared';

import {
  api,
  markSessionConfirmed,
  markSessionEnded,
  markSessionStarted,
  setIsLoggingOut,
  type RequestOptions,
} from '@/lib/api';
import { clearClientSessionState } from '@/lib/sessionTeardown';

/**
 * `GET /auth/me`, and the declaration that its answer licenses.
 *
 * `lib/api` intercepts 401s, and it cannot tell one that ENDED a session from
 * the one a logged-out visitor's me-query returns. This request is what tells it
 * apart, and the answer to it is the only honest evidence there is: the server
 * has just named the user, so there is a session, right now. Declared HERE
 * rather than from an effect over the cached user — an effect fires on every
 * mount, including the ones that read a cached user belonging to a session that
 * has already ended.
 *
 * CONFIRMED, not started: this answer says a session exists, not that one has
 * just begun, and the difference is what the redirect latch turns on. An expiry
 * clears the cache, which sends the me-query back to the network, and re-arming
 * the latch on what comes back is what turned one expiry into a loop of them.
 * Only a login re-arms it.
 *
 * Both callers below share this, and the confirmation is why. `useSessionPresence`
 * hands its 200 straight on to a surface that navigates into the authenticated
 * app, where the cached user it just wrote means `useAuth`'s own query may never
 * reach the network. Were the confirmation to live only in `useAuth`, that
 * session would run with `hasSession` false and its eventual expiry would pass
 * unannounced.
 */
async function fetchMe(opts?: RequestOptions): Promise<User> {
  const me = await api.get<User>('/auth/me', opts);
  markSessionConfirmed();
  return me;
}

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
      // A LOGIN BEGINS FROM CLEAN CLIENT STATE, whatever was on the tab before
      // it. /login no longer bounces an authenticated visitor to /dashboard —
      // that guard is what made a public page mount the me-query and redirect
      // itself away on a cold load — so a signed-in user can reach this form
      // and sign in as somebody else. Without the teardown the second user
      // inherits the first one's cached rows, drawer state and walkthrough.
      // This is the same teardown the logout and expiry paths run; the seeding
      // below has to follow it, or the clear would take the new user with it.
      clearClientSessionState(queryClient);
      // The one answer that means a session BEGAN rather than merely exists, so
      // this is where the 401 interception is re-armed. Seeding the query below
      // means its `queryFn` may not run again for this session, so the session
      // start is declared from the answer that established it.
      markSessionStarted();
      queryClient.setQueryData(['auth', 'me'], data.user);
    },
  });
}

/**
 * The registration mutation, and — like `useLogin` — nothing else.
 *
 * IT IS A LOGIN TOO. `POST /auth/register` swaps the session cookie
 * unconditionally, so an already-signed-in visitor who reaches this form
 * becomes a different user on the same tab, exactly as they would through
 * /login. /register posted straight to `api` and so ran no teardown at all: the
 * new account opened onto the previous user's cached rows, drawer and
 * walkthrough. Same teardown, same order, same re-arm — this is the fourth
 * caller of the one in `lib/sessionTeardown`, not a second copy of it.
 *
 * `markSessionStarted` matters most on the path that begins at an EXPIRY:
 * expiry lands the user on /login, they click through to /register, and without
 * the re-arm here the session they just created has no 401 interception left
 * for the rest of the page's life (see `lib/api`'s `redirecting`).
 *
 * SF-3 applies here as it does to /login: this mounts no `['auth','me']` query,
 * so /register still cold-loads without one
 * (routes/__tests__/public-routes-cold-load.test.tsx).
 */
export function useRegister() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { email: string; password: string; timezone?: string }) =>
      api.post<{ user: User }>('/auth/register', input),
    onSuccess: (data) => {
      clearClientSessionState(queryClient);
      markSessionStarted();
      // After the teardown, or the clear takes the new user out with the old.
      queryClient.setQueryData(['auth', 'me'], data.user);
    },
  });
}

/**
 * Whether anyone is signed in — asked by a surface that is not itself
 * authenticated, and must not become a session-expired notice when the answer
 * is no.
 *
 * THE 404 PAGE IS THE CALLER, AND IT IS NOT A PUBLIC PAGE. /login and the other
 * unauthenticated routes answer this by not asking: they are logged-out by
 * definition, so they mount no me-query at all. The not-found page cannot do
 * that, because it is a dispatcher — what an unknown URL should show genuinely
 * differs for a signed-in user and an anonymous one, so it has to know. Asking
 * through `useAuth` is what made a mistyped URL redirect a logged-out visitor to
 * `/login?expired=true`: the me-query 401s, and the global interception reads
 * every 401 as an expiry.
 *
 * So the question is asked, and `allowUnauthenticated` says a 401 is its answer
 * rather than a session ending. No redirect, no announcement, and the one-shot
 * latch survives for the next real expiry.
 *
 * It shares `['auth','me']` with `useAuth` deliberately: a signed-in user who
 * mistypes a URL mid-session is answered from the cache without a request, and
 * the identity a cold load fetches here is the one the authenticated app then
 * reads.
 */
export function useSessionPresence() {
  const { data: user, isLoading } = useQuery<User>({
    queryKey: ['auth', 'me'],
    queryFn: () => fetchMe({ allowUnauthenticated: true }),
    retry: false,
  });

  return { isLoading, isAuthenticated: !!user };
}

export function useAuth() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: user, isLoading } = useQuery<User>({
    queryKey: ['auth', 'me'],
    queryFn: () => fetchMe(),
    retry: false,
  });

  const loginMutation = useLogin();

  const logoutMutation = useMutation({
    mutationFn: async () => {
      setIsLoggingOut(true);
      return api.post('/auth/logout');
    },
    onSettled: () => {
      // `isLoggingOut` is deliberately NOT cleared here. The teardown below
      // empties the query cache with the authenticated surfaces still mounted,
      // so they all refetch and all of those refetches 401 — after this
      // callback has returned. Clearing the flag first put those 401s back
      // through the interception, which redirected to `/login?expired=true` and
      // reported a deliberate logout as an expiry. The next login clears it
      // (`markSessionStarted`), and so does a page load.
      //
      // The session is over on this path too, so a later 401 must not be read
      // as a second one ending — the teardown below already announced it.
      markSessionEnded();
      clearClientSessionState(queryClient);
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

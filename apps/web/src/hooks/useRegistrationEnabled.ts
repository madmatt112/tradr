import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

interface InstanceConfig {
  registrationEnabled: boolean;
}

/**
 * Whether this instance accepts new accounts, read from `GET /api/config`
 * (newsletter REQ-9.4). It gates the registration form and every link to it, so
 * nobody fills in a whole form the server will refuse at submit.
 *
 * IT IS COURTESY, NOT THE CONTROL. The control is the server refusal on
 * `POST /api/auth/register`; a client that ignores this still cannot register.
 * That is what makes the failure mode below the right one.
 *
 * FAILS OPEN. `?? true` covers both the loading tick and an outright failure —
 * a 404 from an older API, a 401, a dropped connection. A self-hosted instance
 * that has never set DISABLE_REGISTRATION must not hide its own signup because
 * one request blipped, and hiding it would be the client overruling a server
 * that says yes.
 *
 * `allowUnauthenticated` because this question is asked with no session and a
 * 401 is an answer to it, not an expiry: without it lib/api's global
 * interception would send a visitor on /login or /register to
 * `/login?expired=true` and burn the one-shot latch a real expiry needs.
 *
 * `retry: false` so a failure fails once and fails fast — the page waits on this
 * before it renders, and the default 3 tries with backoff would hold a
 * self-hoster on a loading state for seconds before failing open.
 *
 * `staleTime` mirrors the endpoint's own `Cache-Control: public, max-age=60`,
 * and the shared `['config']` key means the login page's read serves the
 * register page too.
 */
export function useRegistrationEnabled(): { registrationEnabled: boolean; isPending: boolean } {
  const { data, isPending } = useQuery<InstanceConfig>({
    queryKey: ['config'],
    queryFn: () => api.get<InstanceConfig>('/config', { allowUnauthenticated: true }),
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return { registrationEnabled: data?.registrationEnabled ?? true, isPending };
}

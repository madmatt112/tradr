import { queryOptions, useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';

interface InstanceConfig {
  registrationEnabled: boolean;
  advisorEnabled: boolean;
}

/**
 * The public instance posture, read once from `GET /api/config` and shared by
 * every consumer through the `['config']` key (the login page's read serves the
 * register page and the sidebar alike).
 *
 * `allowUnauthenticated` because this question is asked with no session and a
 * 401 is an answer to it, not an expiry: without it lib/api's global
 * interception would send a visitor on /login or /register to
 * `/login?expired=true` and burn the one-shot latch a real expiry needs.
 *
 * `retry: false` so a failure fails once and fails fast — pages wait on this
 * before they render, and the default 3 tries with backoff would hold a
 * self-hoster on a loading state for seconds before failing open.
 *
 * `staleTime` mirrors the endpoint's own `Cache-Control: public, max-age=60`.
 */
const instanceConfigQuery = queryOptions<InstanceConfig>({
  queryKey: ['config'],
  queryFn: () => api.get<InstanceConfig>('/config', { allowUnauthenticated: true }),
  staleTime: 60 * 1000,
  refetchOnWindowFocus: false,
  retry: false,
});

/**
 * Whether this instance accepts new accounts (newsletter REQ-9.4). It gates the
 * registration form and every link to it, so nobody fills in a whole form the
 * server will refuse at submit.
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
 */
export function useRegistrationEnabled(): { registrationEnabled: boolean; isPending: boolean } {
  const { data, isPending } = useQuery(instanceConfigQuery);

  return { registrationEnabled: data?.registrationEnabled ?? true, isPending };
}

/**
 * Whether this instance offers the AI advisor. Gates the sidebar entry, the
 * settings tab, the plan card's advisor rows and the options-chain viewer.
 *
 * Courtesy, not control, like {@link useRegistrationEnabled}: the control is
 * the 403 ADVISOR_DISABLED every /api/advisor route answers. Unlike
 * registration it FAILS CLOSED — the advisor is withdrawn by default while it
 * is reworked (DISABLE_ADVISOR defaults to true), so "not yet known" and "could
 * not ask" both mean the surface stays hidden rather than flashing an Advisor
 * item that then disappears. An operator who opted in and hits a blip sees the
 * item return on the next successful read.
 */
export function useAdvisorEnabled(): boolean {
  const { data } = useQuery(instanceConfigQuery);
  return data?.advisorEnabled ?? false;
}

/**
 * The same question for a route `beforeLoad`, which runs outside React. Reads
 * through the singleton QueryClient so the answer is shared with the hooks
 * above and a navigation never re-fetches what the sidebar already holds.
 * Fails closed on any error for the reasons in {@link useAdvisorEnabled}.
 */
export async function isAdvisorEnabledForRoute(): Promise<boolean> {
  try {
    const data = await queryClient.ensureQueryData(instanceConfigQuery);
    return data.advisorEnabled ?? false;
  } catch {
    return false;
  }
}

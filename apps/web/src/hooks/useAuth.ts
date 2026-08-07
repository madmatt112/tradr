import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

import type { User } from '@tradr/shared';

import { api, setIsLoggingOut } from '@/lib/api';
import { DRAWER_STORAGE_KEY } from '@/stores/drawer.store';
import { eventBus } from '@/stores/event-bus.store';

export function useAuth() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: user, isLoading } = useQuery<User>({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get<User>('/auth/me'),
    retry: false,
  });

  const loginMutation = useMutation({
    mutationFn: (credentials: { email: string; password: string }) =>
      api.post<{ user: User }>('/auth/login', credentials),
    onSuccess: (data) => {
      queryClient.setQueryData(['auth', 'me'], data.user);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      setIsLoggingOut(true);
      return api.post('/auth/logout');
    },
    onSettled: () => {
      setIsLoggingOut(false);
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

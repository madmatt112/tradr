import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

import type { User } from '@tradr/shared';

import { api, setIsLoggingOut } from '@/lib/api';
import { DRAWER_STORAGE_KEY } from '@/stores/drawer.store';

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

import { QueryClient } from '@tanstack/react-query';

/**
 * Application-wide singleton QueryClient. Exported separately from `main.tsx`
 * so non-React entry points (e.g. TanStack Router route loaders) can call
 * `queryClient.ensureQueryData(...)` without React context. The same instance
 * is wired into `<QueryClientProvider client={queryClient}>` in `main.tsx`.
 */
export const queryClient = new QueryClient();

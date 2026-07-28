import {
  createRootRoute,
  type ErrorComponentProps,
  Navigate,
  Outlet,
  useRouter,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { VersionBadge } from '@/components/VersionBadge';
import { useAuth } from '@/hooks/useAuth';
import { captureClientException } from '@/lib/telemetry/posthog';

function ErrorComponent({ error }: ErrorComponentProps) {
  const router = useRouter();

  // Report the caught render/loader error to PostHog error tracking. A render
  // error stops at this boundary and never reaches window.onerror, so SDK
  // autocapture would miss it — this is the path that catches it. No-op when
  // PostHog is unconfigured (self-hosted without telemetry); the fallback UI
  // below renders either way. Effect-guarded so capture fires on the error, not
  // during render, and re-fires only when a new error arrives.
  useEffect(() => {
    captureClientException(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="mb-4 text-2xl font-bold">Something went wrong</h1>
        <Button className="cursor-pointer" onClick={() => router.invalidate()}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function NotFoundComponent() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" />;
  }

  return <Navigate to="/login" />;
}

export const Route = createRootRoute({
  component: () => (
    <TooltipProvider>
      <Outlet />
      <Toaster />
      <VersionBadge />
    </TooltipProvider>
  ),
  errorComponent: ErrorComponent,
  notFoundComponent: NotFoundComponent,
});

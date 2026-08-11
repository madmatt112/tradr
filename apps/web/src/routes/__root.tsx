import {
  createRootRoute,
  type ErrorComponentProps,
  Link,
  Navigate,
  Outlet,
  useRouter,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { VersionBadge } from '@/components/VersionBadge';
import { useSessionPresence } from '@/hooks/useAuth';
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

/**
 * What an unknown URL shows, which is two different things.
 *
 * A SIGNED-IN USER IS LOST INSIDE THE APP; AN ANONYMOUS ONE MISTYPED SOMETHING.
 * The first has somewhere to be put back, so they still go to the dashboard. The
 * second used to be sent to /login as well — and getting there took a me-query,
 * which 401s for a visitor with no session, which the api client's global
 * interception answers by navigating to `/login?expired=true`. Mistype a URL, or
 * follow a stale link from anywhere, and the app announced that your session had
 * expired when you never had one.
 *
 * The two are told apart by `useSessionPresence`, which asks the same question
 * `useAuth` does but treats a 401 as the answer "nobody" instead of as an expiry
 * — see its note. Anonymous visitors then get the page below: a plain 404 that
 * says the address is wrong, with a way to sign in for the case where it was
 * only that they were signed out. Being lost and being signed out are different
 * problems and this is where they stopped being the same message.
 */
function NotFoundComponent() {
  const { isLoading, isAuthenticated } = useSessionPresence();

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

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="max-w-sm text-center">
        <h1 className="mb-2 text-2xl font-bold">Page not found</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          We couldn&apos;t find that page. Check the address, or sign in to pick up where you left
          off.
        </p>
        <Button asChild className="cursor-pointer">
          <Link to="/login">Sign in</Link>
        </Button>
      </div>
    </div>
  );
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

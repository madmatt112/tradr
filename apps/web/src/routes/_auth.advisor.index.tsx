import { createFileRoute, redirect } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { isAdvisorEnabledForRoute } from '@/hooks/useRegistrationEnabled';

// INDEX route, deliberately — NOT `_auth.advisor.tsx`. Flat-file dot nesting makes
// `_auth.advisor` the parent of `_auth.advisor.$id` and `_auth.advisor.new`, and a
// parent renders its matched child ONLY through <Outlet />. This file renders the
// whole advisor surface (there is no shared chrome to hoist into a layout), so as a
// parent it silently swallowed both children: `/advisor/{id}` matched, then rendered
// THIS component with conversationId={null} — the "Select a conversation" empty state
// with no transcript and no composer. As an index route, `advisor` becomes a virtual
// parent with no component and all three routes render their own AdvisorPage.
// Regression-tested through the real router in __tests__/advisor-routes.test.tsx.
//
// Lazy-load the advisor surface so its bundle (and the syntax highlighter it
// pulls in) never lands in the initial app bundle (design §Performance).
const AdvisorPage = lazy(() =>
  import('@/features/advisor/pages/AdvisorPage').then((m) => ({ default: m.AdvisorPage })),
);

function AdvisorIndexRoute() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading advisor…</div>}>
      <AdvisorPage conversationId={null} />
    </Suspense>
  );
}

/**
 * Shared by the three advisor routes: on an instance that has withdrawn the
 * advisor (DISABLE_ADVISOR), a typed or bookmarked /advisor URL lands on the
 * dashboard instead of a page whose every request the server would refuse.
 * Courtesy, not control — the 403 is the control.
 */
export async function redirectWhenAdvisorDisabled(): Promise<void> {
  if (!(await isAdvisorEnabledForRoute())) {
    throw redirect({ to: '/dashboard' });
  }
}

export const Route = createFileRoute('/_auth/advisor/')({
  beforeLoad: redirectWhenAdvisorDisabled,
  component: AdvisorIndexRoute,
});

import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';

import { DrawerToggleRefProvider } from '@/components/layout/DrawerToggleRefContext';
import { Sidebar } from '@/components/layout/Sidebar';
import { SideDrawer } from '@/components/layout/SideDrawer';
import { DemoBanner } from '@/features/onboarding/components/DemoBanner';
import { useAuth } from '@/hooks/useAuth';
import { useReportingTimezoneBackfill } from '@/hooks/useUserTimezone';
import { cn } from '@/lib/utils';
import { useDrawerStore } from '@/stores/drawer.store';
import { EventBusBridge } from '@/stores/EventBusBridge';

function AuthLayout() {
  const { isLoading, isAuthenticated } = useAuth();
  // The drawer is a fixed overlay; on the wide, backdrop-less viewports the
  // content yields its width instead of disappearing beneath it (the mock's
  // browse→inspect frame). One state change drives the drawer, the rail's
  // auto-collapse, and this padding, so the width settles in a single reflow.
  const drawerOpen = useDrawerStore((s) => s.isOpen);
  // One-time seeding of a pre-migration reporting timezone. Here because this
  // is the one component every authenticated view mounts under, and exactly
  // once. It returns nothing and gates nothing — the early returns below run
  // whether or not it has anything to do.
  useReportingTimezoneBackfill();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return (
    <DrawerToggleRefProvider>
      <div className="flex min-h-screen">
        <EventBusBridge />
        <Sidebar />
        <main
          className={cn(
            'flex-1 p-6 transition-[padding] duration-200 ease-out motion-reduce:duration-0',
            drawerOpen && 'lg:pr-[384px]',
          )}
        >
          {/* Sample data reaches every derived surface in the app, so the notice
              saying so is mounted HERE rather than on the dashboard — one
              mount, above every route's content, and no page can render
              invented figures without it. The notice is app-wide and persistent
              for exactly that reason, and it carries the action that removes the
              data. It renders nothing at all when there is no sample data. */}
          <DemoBanner />
          <Outlet />
        </main>
        <SideDrawer />
      </div>
    </DrawerToggleRefProvider>
  );
}

export const Route = createFileRoute('/_auth')({
  component: AuthLayout,
});

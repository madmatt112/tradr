import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';

import { DrawerToggle } from '@/components/layout/DrawerToggle';
import { DrawerToggleRefProvider } from '@/components/layout/DrawerToggleRefContext';
import { Sidebar } from '@/components/layout/Sidebar';
import { SideDrawer } from '@/components/layout/SideDrawer';
import { useAuth } from '@/hooks/useAuth';
import { EventBusBridge } from '@/stores/EventBusBridge';

function AuthLayout() {
  const { isLoading, isAuthenticated } = useAuth();

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
        <main className="flex-1 p-6">
          <DrawerToggle />
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

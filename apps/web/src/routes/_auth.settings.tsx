import { createFileRoute, Link, Outlet, redirect, useLocation } from '@tanstack/react-router';
import { Bot, CircleQuestionMark, Settings as SettingsIcon, User, Wallet } from 'lucide-react';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// Single composition point for the Settings shell. New tabs are added by
// extending this array (REQ-7.11). `route` is the absolute path each tab owns.
const SETTINGS_TABS = [
  { id: 'advisor', label: 'Advisor', icon: Bot, route: '/settings/advisor' },
  { id: 'billing', label: 'Billing', icon: Wallet, route: '/settings/billing' },
  { id: 'profile', label: 'Profile', icon: User, route: '/settings/profile' },
  { id: 'account', label: 'Account', icon: SettingsIcon, route: '/settings/account' },
  // The guided walkthrough's permanent home. It lives here rather than on the
  // dashboard because every dashboard door into it is temporary: the zero-state
  // goes when the first account is created and the activation checklist retires
  // when all four items are done.
  { id: 'help', label: 'Help', icon: CircleQuestionMark, route: '/settings/help' },
] as const;

function SettingsLayout() {
  const { pathname } = useLocation();
  // Active tab is driven by the URL (REQ-7.2). Fall back to advisor.
  const active = SETTINGS_TABS.find((t) => pathname.startsWith(t.route))?.id ?? 'advisor';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Tabs value={active} orientation="vertical" className="flex-row">
        <TabsList variant="line" className="shrink-0">
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.id} value={tab.id} asChild className="cursor-pointer">
                <Link to={tab.route}>
                  <Icon aria-hidden="true" />
                  {tab.label}
                </Link>
              </TabsTrigger>
            );
          })}
        </TabsList>
        <div className="flex-1">
          <Outlet />
        </div>
      </Tabs>
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings')({
  beforeLoad: ({ location }) => {
    // `/settings` itself has no content — redirect to the default tab (REQ-7.2).
    if (location.pathname === '/settings' || location.pathname === '/settings/') {
      throw redirect({ to: '/settings/advisor' });
    }
  },
  component: SettingsLayout,
});

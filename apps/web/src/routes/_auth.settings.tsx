import { createFileRoute, Link, Outlet, redirect, useLocation } from '@tanstack/react-router';
import { Bot, CircleQuestionMark, Settings as SettingsIcon, User, Wallet } from 'lucide-react';

import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isAdvisorEnabledForRoute, useAdvisorEnabled } from '@/hooks/useRegistrationEnabled';

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

/**
 * The tabs this instance shows. The Advisor tab goes with the advisor itself
 * (DISABLE_ADVISOR): its every control — provider keys, the market-data key,
 * consent, personas — talks to routes the server refuses.
 */
function visibleTabs(advisorEnabled: boolean) {
  return advisorEnabled ? SETTINGS_TABS : SETTINGS_TABS.filter((t) => t.id !== 'advisor');
}

function SettingsLayout() {
  const { pathname } = useLocation();
  const tabs = visibleTabs(useAdvisorEnabled());
  // Active tab is driven by the URL (REQ-7.2). Fall back to the first tab.
  const active = tabs.find((t) => pathname.startsWith(t.route))?.id ?? tabs[0].id;

  return (
    <div className="space-y-6">
      <PageHeader page="Settings" className="mb-0" />
      <Tabs value={active} orientation="vertical" className="flex-row">
        <TabsList variant="line" className="shrink-0">
          {tabs.map((tab) => {
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
  beforeLoad: async ({ location }) => {
    // `/settings` itself has no content — redirect to the default tab (REQ-7.2):
    // Advisor where it is offered, otherwise the first tab that is.
    if (location.pathname === '/settings' || location.pathname === '/settings/') {
      throw redirect({ to: visibleTabs(await isAdvisorEnabledForRoute())[0].route });
    }
  },
  component: SettingsLayout,
});

import { Link } from '@tanstack/react-router';
import { LineChart, Megaphone, Receipt, Shield, Sigma, Sparkles, Upload } from 'lucide-react';
import { useState, useEffect } from 'react';

import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { Button } from '@/components/ui/button';
import { hasNewReleases, useChangelogReleases } from '@/features/changelog/hooks/useChangelog';
import { derivePresetRange } from '@/features/performance/utils/derivePresetRange';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

// Default search params for the Performance route. The route's
// `validateSearch` requires `granularity`, `start`, and `end`; the sidebar
// is the entry point so it has to seed sensible defaults. We use the
// `monthly` preset (12m window) anchored at the user's browser timezone.
function buildPerformanceDefaults(): {
  granularity: 'day' | 'week' | 'month' | 'year';
  start: string;
  end: string;
  tz: string;
} {
  const tz =
    (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const range = derivePresetRange(
    'monthly',
    { earliestClosedAt: null, mostRecentClosedAt: null, totalClosedPositions: 0 },
    new Date(),
    tz,
    0,
  );
  return { granularity: range.granularity, start: range.start, end: range.end, tz };
}

const COLLAPSED_KEY = 'sidebar-collapsed';

export function Sidebar() {
  const { user, logout } = useAuth();
  // Badge data: error/loading mean no `data`, so the badge is simply absent
  // (REQ-5(a)(5)) — the hook's `retry: false` keeps failures quiet.
  const changelogReleases = useChangelogReleases();
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  return (
    <aside
      className={cn(
        'flex flex-col border-r bg-card transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className="flex items-center justify-between border-b p-3">
        {!collapsed && <span className="text-lg font-semibold">Tradr</span>}
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon-sm"
            className="cursor-pointer"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '»' : '«'}
          </Button>
        </div>
      </div>

      <nav className="flex-1 p-2">
        <Link
          to="/dashboard"
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <span>▦</span>
          {!collapsed && <span>Dashboard</span>}
        </Link>
        <Link
          to="/advisor"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {!collapsed && <span>Advisor</span>}
        </Link>
        <Link
          to="/positions"
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <span>◈</span>
          {!collapsed && <span>Positions</span>}
        </Link>
        <Link
          to="/import"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          {!collapsed && <span>Import</span>}
        </Link>
        <Link
          to="/calculator"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <span>∑</span>
          {!collapsed && <span>Calculator</span>}
        </Link>
        <Link
          to="/performance"
          search={buildPerformanceDefaults}
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <LineChart className="h-4 w-4" aria-hidden="true" />
          {!collapsed && <span>Performance</span>}
        </Link>
        <Link
          to="/options"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <Sigma className="h-4 w-4" aria-hidden="true" />
          {!collapsed && <span>Options</span>}
        </Link>
        <Link
          to="/accounting/expenses"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <Receipt className="h-4 w-4" aria-hidden="true" />
          {!collapsed && <span>Accounting</span>}
        </Link>
        <Link
          to="/accounts"
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <span>⊞</span>
          {!collapsed && <span>Accounts</span>}
        </Link>
        <Link
          to="/brokerages"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <span>⌂</span>
          {!collapsed && <span>Brokerages</span>}
        </Link>
        <Link
          to="/changelog"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          {/* The dot anchors to the icon (relative wrapper), not the label —
              the collapsed w-16 rail hides all label <span>s. */}
          <span className="relative">
            <Megaphone className="h-4 w-4" aria-hidden="true" />
            {hasNewReleases(changelogReleases.data) && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary">
                <span className="sr-only">New updates available</span>
              </span>
            )}
          </span>
          {!collapsed && <span>Changelog</span>}
        </Link>
        <Link
          to="/settings"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
            '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
          )}
        >
          <span>⚙</span>
          {!collapsed && <span>Settings</span>}
        </Link>
        {user?.isAdmin && (
          <Link
            to="/admin"
            className={cn(
              'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
              '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
            )}
          >
            <Shield className="h-4 w-4" aria-hidden="true" />
            {!collapsed && <span>Admin</span>}
          </Link>
        )}
      </nav>

      <div className="border-t p-3">
        {!collapsed && user && (
          <p className="mb-2 truncate text-xs text-muted-foreground">{user.email}</p>
        )}
        <Button
          variant="ghost"
          size={collapsed ? 'icon-sm' : 'sm'}
          className="w-full cursor-pointer"
          onClick={() => logout.mutate()}
        >
          {collapsed ? '⏻' : 'Log out'}
        </Button>
      </div>
    </aside>
  );
}

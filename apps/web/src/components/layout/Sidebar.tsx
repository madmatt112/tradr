import { Link } from '@tanstack/react-router';
import {
  BookOpen,
  LineChart,
  Megaphone,
  Receipt,
  Shield,
  Sigma,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useState, useEffect } from 'react';

import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { Button } from '@/components/ui/button';
import { hasNewReleases, useChangelogReleases } from '@/features/changelog/hooks/useChangelog';
import { derivePresetRange } from '@/features/performance/utils/derivePresetRange';
import { useAuth } from '@/hooks/useAuth';
import { useUserTimezone } from '@/hooks/useUserTimezone';
import { docsUrl } from '@/lib/docs';
import { cn } from '@/lib/utils';

// Default search params for the Performance route. The route's
// `validateSearch` requires `granularity`, `start`, and `end`; the sidebar
// is the entry point so it has to seed sensible defaults. We use the
// `monthly` preset (12m window) anchored at the user's STORED reporting
// timezone.
//
// `tz` is a parameter rather than something this function derives: it comes
// from `useUserTimezone()`, and a hook cannot be read from module scope. The
// caller reads it inside the component and passes it down.
function buildPerformanceDefaults(tz: string): {
  granularity: 'day' | 'week' | 'month' | 'year';
  start: string;
  end: string;
  tz: string;
} {
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

const PERFORMANCE_NAV_CLASS = cn(
  'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
  '[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium',
);

export function Sidebar() {
  const { user, logout } = useAuth();
  // The stored reporting timezone anchors the Performance route's default
  // window. `undefined` until the preference query settles — and unlike the
  // widgets there is no query here to disable, only a destination to seed, so
  // the item is inert until there is a correct destination. Linking with the
  // browser's zone (or a client-side 'UTC') is exactly the per-device bucketing
  // the stored preference exists to replace.
  const timezone = useUserTimezone();
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
    // `sticky top-0 h-screen` decouples the rail from the page: as a plain flex
    // child it stretched to the height of <main>, which puts the footer — and
    // the Log out button in it — at the bottom of the DOCUMENT rather than the
    // viewport, out of sight on any long route. The explicit height also stops
    // `align-items: stretch` from re-growing it.
    <aside
      className={cn(
        'sticky top-0 flex h-screen flex-col border-r bg-card transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className="flex shrink-0 items-center justify-between border-b p-3">
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

      {/* `min-h-0` is what lets this shrink below its content height (a flex
          child's default `min-height: auto` would otherwise push the footer
          off the bottom); `overflow-y-auto` then scrolls the links themselves
          on a short viewport, leaving the footer pinned. */}
      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
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
        {timezone ? (
          <Link
            to="/performance"
            search={() => buildPerformanceDefaults(timezone)}
            className={PERFORMANCE_NAV_CLASS}
          >
            <LineChart className="h-4 w-4" aria-hidden="true" />
            {!collapsed && <span>Performance</span>}
          </Link>
        ) : (
          // `role` and `tabIndex` are what make the inert state perceivable:
          // `aria-disabled` on a bare <span> is announced to nobody, and
          // without a tab stop a keyboard user skips the item entirely and
          // never learns it is there. Focusable-but-disabled (rather than
          // removed from the tab order) is the pattern that keeps the nav's
          // tab sequence stable across the in-flight window.
          <span
            role="link"
            aria-disabled="true"
            tabIndex={0}
            className={cn(PERFORMANCE_NAV_CLASS, 'pointer-events-none opacity-50')}
          >
            <LineChart className="h-4 w-4" aria-hidden="true" />
            {!collapsed && <span>Performance</span>}
          </span>
        )}
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
        {/* The documentation lives on its own host, so this is an <a>, not a
            router <Link>. New tab: a reader following it is mid-task and should
            not lose the page they were on. */}
        <a
          href={docsUrl('home')}
          target="_blank"
          rel="noreferrer"
          title="Documentation"
          className={cn(
            'cursor-pointer flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
          )}
        >
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          {!collapsed && <span>Docs</span>}
        </a>
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

      <div className="shrink-0 border-t p-3">
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

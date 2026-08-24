import { Link } from '@tanstack/react-router';
import {
  ArrowDownToLine,
  BarChart3,
  BookOpen,
  Calculator,
  CreditCard,
  Landmark,
  LayoutDashboard,
  List,
  LogOut,
  Megaphone,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Settings,
  Shield,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { Button } from '@/components/ui/button';
import { hasNewReleases, useChangelogReleases } from '@/features/changelog/hooks/useChangelog';
import { useSidebarPin } from '@/features/onboarding/hooks/useSidebarPin';
import { useAuth } from '@/hooks/useAuth';
import { useAdvisorEnabled } from '@/hooks/useRegistrationEnabled';
import { docsUrl } from '@/lib/docs';
import { cn } from '@/lib/utils';
import { useDrawerStore } from '@/stores/drawer.store';

// The direction-B desk chrome: a 56px icon rail by default, pinnable to a
// 208px labeled state. The pin is a per-user preference (useSidebarPin); the
// side drawer opening auto-collapses the rail to icons and closing restores
// the pin — derived (`pinned && !drawerOpen`), never juggled as state.
const RAIL_WIDTH = 'w-14'; // 56px
const EXPANDED_WIDTH = 'w-52'; // 208px

// One nav item in either chrome state. The accessible name is ALWAYS the
// aria-label — the rail state has no inline label at all (its hover label is
// the native title tooltip; a styled flyout cannot escape the nav's scroll
// container) — so the name is identical across both states.
const ITEM_EXPANDED = cn(
  'cursor-pointer flex items-center gap-2.5 rounded-md border-l-2 border-transparent px-2 py-1.5',
  'text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
  '[&.active]:bg-secondary [&.active]:text-foreground [&.active]:border-primary [&.active]:rounded-l-none',
);
const ITEM_RAIL = cn(
  'cursor-pointer relative grid h-[34px] w-[38px] place-items-center rounded-md',
  'text-muted-foreground hover:bg-accent hover:text-foreground',
  '[&.active]:bg-secondary [&.active]:text-foreground',
  // The amber active tick, drawn just off the item's left edge (mock: 2px bar).
  "[&.active]:before:absolute [&.active]:before:-left-[9px] [&.active]:before:top-2 [&.active]:before:bottom-2 [&.active]:before:w-0.5 [&.active]:before:bg-primary [&.active]:before:content-['']",
);

function itemClass(expanded: boolean): string {
  return expanded ? ITEM_EXPANDED : ITEM_RAIL;
}

function ItemContent({
  expanded,
  label,
  Icon,
  badge,
}: {
  expanded: boolean;
  label: string;
  Icon: LucideIcon;
  badge?: ReactNode;
}) {
  return (
    <>
      {/* The badge dot anchors to the icon, not the label — the rail state
          renders no inline label at all. */}
      <span className="relative">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {badge}
      </span>
      {expanded && (
        <span aria-hidden="true" className="truncate">
          {label}
        </span>
      )}
    </>
  );
}

/** Mono uppercase group label (expanded) / hairline divider (rail). */
function GroupLabel({ expanded, label }: { expanded: boolean; label: string }) {
  if (!expanded) {
    return <div aria-hidden="true" className="mx-auto my-2 w-[22px] border-t border-hairline" />;
  }
  return (
    <div className="px-2 pb-1 pt-3 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground/80">
      {label}
    </div>
  );
}

export function Sidebar() {
  const advisorEnabled = useAdvisorEnabled();
  const { user, logout } = useAuth();
  // Badge data: error/loading mean no `data`, so the badge is simply absent
  // (REQ-5(a)(5)) — the hook's `retry: false` keeps failures quiet.
  const changelogReleases = useChangelogReleases();
  const { pinned, setPinned } = useSidebarPin();
  const drawerOpen = useDrawerStore((s) => s.isOpen);

  // Auto-collapse while the drawer is open; the pin survives and the labeled
  // state comes back on its own when the drawer closes.
  const expanded = pinned && !drawerOpen;

  const changelogBadge = hasNewReleases(changelogReleases.data) ? (
    <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary">
      <span className="sr-only">New updates available</span>
    </span>
  ) : undefined;

  return (
    // `sticky top-0 h-screen` decouples the rail from the page: as a plain flex
    // child it stretched to the height of <main>, which puts the footer — and
    // the Log out button in it — at the bottom of the DOCUMENT rather than the
    // viewport, out of sight on any long route. The explicit height also stops
    // `align-items: stretch` from re-growing it.
    <aside
      className={cn(
        'sticky top-0 flex h-screen flex-col border-r border-hairline bg-card',
        'transition-[width] duration-200 motion-reduce:duration-0',
        expanded ? EXPANDED_WIDTH : RAIL_WIDTH,
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center py-3',
          expanded ? 'justify-between px-3' : 'flex-col gap-1 px-0',
        )}
      >
        {expanded ? (
          <span className="flex items-baseline gap-1.5 text-base font-bold">
            <span aria-hidden="true" className="text-xs text-primary">
              ▴
            </span>
            Tradr
          </span>
        ) : (
          <span aria-hidden="true" className="text-base text-primary">
            ▴
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="cursor-pointer text-muted-foreground"
          onClick={() => setPinned(!pinned)}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {expanded ? (
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>

      {/* `min-h-0` is what lets this shrink below its content height (a flex
          child's default `min-height: auto` would otherwise push the footer
          off the bottom); `overflow-y-auto` then scrolls the links themselves
          on a short viewport, leaving the footer pinned. (It is also why the
          rail's hover labels are native title tooltips — a styled flyout could
          not escape this scroll container.) */}
      <nav
        className={cn(
          'min-h-0 flex-1 overflow-y-auto py-1',
          expanded ? 'px-2' : 'flex flex-col items-center gap-1 px-0',
        )}
      >
        <Link
          to="/dashboard"
          aria-label="Dashboard"
          title={expanded ? undefined : 'Dashboard'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Dashboard" Icon={LayoutDashboard} />
        </Link>
        {advisorEnabled && (
          <Link
            to="/advisor"
            aria-label="Advisor"
            title={expanded ? undefined : 'Advisor'}
            className={itemClass(expanded)}
          >
            <ItemContent expanded={expanded} label="Advisor" Icon={Sparkles} />
          </Link>
        )}

        <GroupLabel expanded={expanded} label="Trade" />
        <Link
          to="/positions"
          aria-label="Positions"
          title={expanded ? undefined : 'Positions'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Positions" Icon={TrendingUp} />
        </Link>
        <Link
          to="/calculator"
          aria-label="Calculator"
          title={expanded ? undefined : 'Calculator'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Calculator" Icon={Calculator} />
        </Link>
        <Link
          to="/options"
          aria-label="Options"
          title={expanded ? undefined : 'Options'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Options" Icon={List} />
        </Link>
        <Link
          to="/import"
          aria-label="Import"
          title={expanded ? undefined : 'Import'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Import" Icon={ArrowDownToLine} />
        </Link>

        <GroupLabel expanded={expanded} label="Review" />
        {/* A plain link: the Performance route derives its own monthly-preset
            defaults at the boundary now, so the nav no longer seeds a search
            window or sits inert while the stored timezone loads. */}
        <Link
          to="/performance"
          aria-label="Performance"
          title={expanded ? undefined : 'Performance'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Performance" Icon={BarChart3} />
        </Link>
        <Link
          to="/accounting/expenses"
          aria-label="Accounting"
          title={expanded ? undefined : 'Accounting'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Accounting" Icon={Receipt} />
        </Link>
        <Link
          to="/accounts"
          aria-label="Accounts"
          title={expanded ? undefined : 'Accounts'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Accounts" Icon={CreditCard} />
        </Link>
        <Link
          to="/brokerages"
          aria-label="Brokerages"
          title={expanded ? undefined : 'Brokerages'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Brokerages" Icon={Landmark} />
        </Link>

        <GroupLabel expanded={expanded} label="System" />
        <Link
          to="/settings"
          aria-label="Settings"
          title={expanded ? undefined : 'Settings'}
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Settings" Icon={Settings} />
        </Link>
        <Link
          to="/changelog"
          aria-label="Changelog"
          title={expanded ? undefined : 'Changelog'}
          className={itemClass(expanded)}
        >
          <ItemContent
            expanded={expanded}
            label="Changelog"
            Icon={Megaphone}
            badge={changelogBadge}
          />
        </Link>
        {/* The documentation lives on its own host, so this is an <a>, not a
            router <Link>. New tab: a reader following it is mid-task and should
            not lose the page they were on. */}
        <a
          href={docsUrl('home')}
          target="_blank"
          rel="noreferrer"
          aria-label="Docs"
          className={itemClass(expanded)}
        >
          <ItemContent expanded={expanded} label="Docs" Icon={BookOpen} />
        </a>
        {user?.isAdmin && (
          <Link
            to="/admin"
            aria-label="Admin"
            title={expanded ? undefined : 'Admin'}
            className={itemClass(expanded)}
          >
            <ItemContent expanded={expanded} label="Admin" Icon={Shield} />
          </Link>
        )}
      </nav>

      {/* Bottom cluster: theme + session. In the rail state everything is
          icon-sized; the accessible names never change. */}
      <div
        className={cn(
          'shrink-0 border-t border-hairline p-2',
          expanded ? 'px-3 py-3' : 'flex flex-col items-center gap-1',
        )}
      >
        {expanded && user && (
          <p className="mb-2 truncate font-mono text-xs text-muted-foreground">{user.email}</p>
        )}
        <div className={cn('flex items-center', expanded ? 'justify-between' : 'flex-col gap-1')}>
          <ThemeToggle />
          <Button
            variant="ghost"
            size={expanded ? 'sm' : 'icon-sm'}
            className="cursor-pointer text-muted-foreground"
            onClick={() => logout.mutate()}
            aria-label="Log out"
          >
            {expanded ? 'Log out' : <LogOut className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </aside>
  );
}

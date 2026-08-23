import type { ReactNode } from 'react';

import { DrawerToggle } from '@/components/layout/DrawerToggle';
import { cn } from '@/lib/utils';

// The desk page-header grammar (visual-redesign 2.3): a mono `▴ page-name`
// strip that replaces the old shouting h1 rows. The name renders lowercase
// (CSS) over a properly-cased label so the accessible name stays natural.
//
// `chips` holds scope pickers BOUND TO EXISTING filters/settings only — the
// header never grows its own backend scoping. `right` is the strip's trailing
// cluster (page stats, actions).
export function PageHeader({
  page,
  chips,
  right,
  className,
}: {
  /** Properly-cased page name ("Positions"); rendered lowercase. */
  page: string;
  /** Scope chips bound to the page's own existing filters/settings. */
  chips?: ReactNode;
  /** Trailing cluster: counts, stats, or the page's primary action. */
  right?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
        'border-b border-hairline pb-2.5',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="flex items-baseline gap-1.5 font-mono text-sm font-semibold lowercase">
          <span aria-hidden="true" className="text-primary">
            ▴
          </span>
          {page}
        </h1>
        {chips}
      </div>
      <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
        {right}
        {/* The app-wide drawer opener lives at the end of every page-header
            strip — the slot the old 48px top bar existed for. */}
        <DrawerToggle />
      </div>
    </header>
  );
}

// A chip-shaped scope control. Interactive when `onClick` is given (a real
// <button>, pointer cursor per CLAUDE.md); otherwise a static display chip.
export function ScopeChip({
  children,
  onClick,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  'aria-label'?: string;
}) {
  const look = cn(
    'inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-0.5',
    'font-mono text-xs text-muted-foreground',
    className,
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={cn(look, 'cursor-pointer hover:border-border hover:text-foreground')}
      >
        {children}
      </button>
    );
  }
  return <span className={look}>{children}</span>;
}

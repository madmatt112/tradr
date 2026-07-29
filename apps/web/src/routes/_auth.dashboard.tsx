import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import {
  DEFAULT_WIDGETS,
  WIDGET_DEFAULT_NAMESPACE,
  uuidv5Batch,
  type WidgetPlacement,
} from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DashboardGrid } from '@/features/dashboard/components/DashboardGrid';
import { DashboardHeader } from '@/features/dashboard/components/DashboardHeader';
import { GRID_COLUMNS } from '@/features/dashboard/grid.constants';
import { useDashboardLayout } from '@/features/dashboard/hooks/useDashboardLayout';
import { findFirstSlot } from '@/features/dashboard/layout';
import { useAuth } from '@/hooks/useAuth';

/**
 * Loading skeleton — mirrors the geometry of DEFAULT_WIDGETS so the screen
 * doesn't reflow on first paint (Req 4.5).
 */
function DashboardSkeleton(): ReactElement {
  return (
    <div
      data-slot="dashboard-skeleton"
      aria-busy="true"
      aria-label="Loading dashboard"
      className="grid w-full gap-4"
      style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}
    >
      {DEFAULT_WIDGETS.map((d) => (
        <Skeleton
          key={d.type}
          className="h-32"
          style={{
            gridColumn: `${d.x + 1} / span ${d.w}`,
            gridRow: `${d.y + 1} / span ${d.h}`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Read-only error fallback — renders DEFAULT_WIDGETS as static skeletons.
 * Per Req 4.3 this is INTENTIONALLY non-interactive: no drag, no resize, no
 * PUT until the next successful GET.
 */
function ReadOnlyDefaultLayout(): ReactElement {
  return (
    <div
      data-slot="dashboard-error-fallback"
      aria-disabled="true"
      className="grid w-full gap-4 opacity-60"
      style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}
    >
      {DEFAULT_WIDGETS.map((d) => (
        <div
          key={d.type}
          data-widget-type={d.type}
          className="rounded-md border bg-card p-3 text-sm text-muted-foreground"
          style={{
            gridColumn: `${d.x + 1} / span ${d.w}`,
            gridRow: `${d.y + 1} / span ${d.h}`,
          }}
        >
          {d.type}
        </div>
      ))}
    </div>
  );
}

function DashboardPage(): ReactElement {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const layout = useDashboardLayout();
  const { data, isLoading, isError, refetch, flushPending, scheduleLayoutWrite } = layout;

  // beforeunload: flush any pending debounced PUT (Req 1.9).
  useEffect(() => {
    function handleBeforeUnload(): void {
      flushPending();
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [flushPending]);

  // Async "Use the default layout" state (Req 2.9 + §I.4).
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false);
  const spinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (spinnerTimerRef.current !== null) {
        clearTimeout(spinnerTimerRef.current);
      }
    };
  }, []);

  // User-action handlers — these are the ONLY paths that call
  // scheduleLayoutWrite. NEVER call it on every render.
  const widgets: WidgetPlacement[] = data?.widgets ?? [];

  // `scheduleLayoutWrite` debounces for 300ms and keeps ONE pending body, so a
  // handler that ignores the pending value silently discards whatever edit is
  // already queued. Two ways that bites:
  //
  //   - A widget's config fix-up (§K) fires on mount, off a render-scoped
  //     callback. If it lands after a drag it would re-send the pre-drag
  //     positions and the drag is lost — reproducibly, for any drag within
  //     ~1.5s of load.
  //   - A `theme` write pending from `useAppTheme` would be dropped by the next
  //     layout edit, since these handlers only ever set `widgets`.
  //
  // So every handler now merges onto the pending body, and computes from
  // `pending.widgets` when one is queued. `widgetsRef` supplies the fallback so
  // a stale render closure cannot resurrect an old layout either.
  const widgetsRef = useRef<WidgetPlacement[]>(widgets);
  widgetsRef.current = widgets;

  const handleAdd = useCallback(
    (placement: WidgetPlacement) => {
      scheduleLayoutWrite((pending) => {
        // The popover packs against an empty grid because it only knows the
        // placed TYPES, so every widget it emits is positioned at (0, 0).
        // Re-slot it here against the real placements — otherwise the new
        // widget overlaps whatever is at the origin and the PUT fails
        // `checkNoOverlap`.
        const base = pending.widgets ?? widgetsRef.current;
        const { x, y } = findFirstSlot(base, { w: placement.w, h: placement.h });
        return { ...pending, widgets: [...base, { ...placement, x, y }] };
      });
    },
    [scheduleLayoutWrite],
  );

  const handleRemove = useCallback(
    (id: string) => {
      scheduleLayoutWrite((pending) => {
        const base = pending.widgets ?? widgetsRef.current;
        return { ...pending, widgets: base.filter((w) => w.id !== id) };
      });
    },
    [scheduleLayoutWrite],
  );

  const handleGridChange = useCallback(
    (next: WidgetPlacement[]) => {
      // The grid resolved these placements from its own live echo, so they are
      // authoritative for geometry; only `theme` is carried over.
      scheduleLayoutWrite((pending) => ({ ...pending, widgets: next }));
    },
    [scheduleLayoutWrite],
  );

  const handleUpdateConfig = useCallback(
    (widgetId: string, config: Record<string, unknown>) => {
      scheduleLayoutWrite((pending) => {
        const base = pending.widgets ?? widgetsRef.current;
        const next = base.map((w) => {
          if (w.id !== widgetId) return w;
          const prev =
            w.config && typeof w.config === 'object' ? (w.config as Record<string, unknown>) : {};
          return { ...w, config: { ...prev, ...config } };
        });
        return { ...pending, widgets: next };
      });
    },
    [scheduleLayoutWrite],
  );

  const handleUseDefaultLayout = useCallback(async () => {
    if (defaultBusy) return;
    setDefaultBusy(true);
    // §I.4: visible spinner only if the computation takes > 100ms.
    spinnerTimerRef.current = setTimeout(() => {
      setShowSpinner(true);
    }, 100);
    try {
      const names = DEFAULT_WIDGETS.map((w) => `${userId}:${w.type}`);
      const ids = await uuidv5Batch(names, WIDGET_DEFAULT_NAMESPACE);
      const built: WidgetPlacement[] = DEFAULT_WIDGETS.map((w, i) => ({
        id: ids[i],
        type: w.type,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
      }));
      scheduleLayoutWrite(() => ({ widgets: built }));
    } finally {
      if (spinnerTimerRef.current !== null) {
        clearTimeout(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
      setShowSpinner(false);
      setDefaultBusy(false);
    }
  }, [defaultBusy, userId, scheduleLayoutWrite]);

  // Loading
  if (isLoading) {
    return <DashboardSkeleton />;
  }

  // Error — read-only fallback per Req 4.3.
  if (isError) {
    return (
      <div className="space-y-6">
        <EmptyState
          title="Couldn't load your dashboard"
          description="Showing the default layout. Your changes will not be saved until we can reach the server."
          action={
            <Button type="button" className="cursor-pointer" onClick={() => refetch()}>
              Retry
            </Button>
          }
        />
        <ReadOnlyDefaultLayout />
      </div>
    );
  }

  // Empty
  if (widgets.length === 0) {
    return (
      <div className="space-y-6">
        <EmptyState
          title="Your dashboard is empty"
          description="Add widgets to get started, or load the default layout."
          action={
            <div
              data-slot="dashboard-empty-actions"
              aria-busy={defaultBusy}
              className="flex items-center gap-2"
            >
              <DashboardHeader placedTypes={[]} onAdd={handleAdd} />
              <Button
                type="button"
                className="cursor-pointer"
                onClick={() => {
                  void handleUseDefaultLayout();
                }}
                disabled={defaultBusy}
              >
                {showSpinner ? (
                  <span
                    aria-hidden="true"
                    data-slot="dashboard-default-spinner"
                    className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
                  />
                ) : null}
                Use the default layout
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  // Populated
  const placedTypes = widgets.map((w) => w.type);
  return (
    <div className="space-y-4">
      <DashboardHeader
        placedTypes={placedTypes}
        onAdd={handleAdd}
        onResetLayout={() => {
          void handleUseDefaultLayout();
        }}
        resetBusy={defaultBusy}
      />
      <DashboardGrid
        widgets={widgets}
        onRemove={handleRemove}
        scheduleLayoutWrite={handleGridChange}
        onUpdateConfig={handleUpdateConfig}
      />
    </div>
  );
}

export const Route = createFileRoute('/_auth/dashboard')({
  component: DashboardPage,
});

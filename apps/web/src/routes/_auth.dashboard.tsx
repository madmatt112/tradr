import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import {
  DEFAULT_WIDGETS,
  WIDGET_DEFAULT_NAMESPACE,
  uuidv5Batch,
  type WidgetPlacement,
} from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { DashboardGrid } from '@/features/dashboard/components/DashboardGrid';
import { DashboardHeader } from '@/features/dashboard/components/DashboardHeader';
import { GRID_COLUMNS } from '@/features/dashboard/grid.constants';
import { useDashboardLayout } from '@/features/dashboard/hooks/useDashboardLayout';
import { findFirstSlot } from '@/features/dashboard/layout';
import {
  ActivationChecklist,
  resolveChecklistView,
} from '@/features/onboarding/components/ActivationChecklist';
import { CoachMark } from '@/features/onboarding/components/CoachMark';
import { ZeroState } from '@/features/onboarding/components/ZeroState';
import { useOnboarding } from '@/features/onboarding/hooks/useOnboarding';
import { useWalkthrough } from '@/features/onboarding/hooks/useWalkthrough';
import type { ChecklistItemId } from '@/features/onboarding/lib/derive-checklist';
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

/**
 * The checklist's grid footprint: the width of the right-rail widgets under it
 * in the default layout and the Stats Summary's height, so the top row of the
 * default dashboard becomes Stats Summary at eight columns beside it. The id is
 * the grid's handle for the item and must never be a widget id.
 */
const CHECKLIST_ASIDE = { id: 'activation-checklist', w: 4, h: 6 } as const;

/**
 * The checklist, wired to the walkthrough, for the populated and empty-layout
 * branches. It decides nothing about WHETHER to render — `ActivationChecklist`
 * answers for every state itself, and the route reads the same answer through
 * `resolveChecklistView` to know whether the grid has to make room.
 */
function ChecklistSlot(): ReactElement {
  // THE WALKTHROUGH'S OTHER DOOR, and without it items 2-4 had none. `ZeroState`
  // wires the checklist's per-item "Start" to the walkthrough, but a user leaves
  // the zero-state the instant they create their first account — which is the
  // instant "size a trade", "log a position" and "close it" become the
  // outstanding work. Their step sets shipped and nothing could open them.
  //
  // The two lines below are `ZeroState.beginGuided`, for the same reason it
  // gives: the status write is the opt-in record ("this user asked to be
  // guided"), and it belongs at the door rather than in `useWalkthrough`, which
  // deliberately writes no onboarding state at all. Choosing one item off the
  // checklist is the same choice made about one step instead of four.
  //
  // No params: `useWalkthrough` fills in the position a set needs from the
  // user's own data, which is the only place that knows it.
  const { start, canStart, isUnavailable } = useWalkthrough();
  const { setStatus } = useOnboarding();
  const beginGuided = useCallback(
    (itemId: ChecklistItemId) => {
      setStatus('active');
      start(itemId);
    },
    [setStatus, start],
  );

  // Withdrawn when the tour runtime will not load, exactly as the zero-state
  // withdraws it: a "Start" with nothing behind it is a dead control, and the
  // checklist is useful without one.
  //
  // `canStart` withholds the same thing one set at a time. On THIS screen the
  // user has an account, so the account set's first step — the zero-state's
  // "Create my first account" — is a control this branch by definition does
  // not render.
  return (
    <ActivationChecklist
      onStartStep={isUnavailable ? undefined : beginGuided}
      canStartStep={canStart}
    />
  );
}

function DashboardPage(): ReactElement {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const layout = useDashboardLayout();
  const { data, isLoading, isError, refetch, flushPending, scheduleLayoutWrite } = layout;

  // ===========================================================================
  // THE WELCOME-VIEW GATE.
  //
  // A user still setting up gets a screen that tells them what to do instead of
  // six widgets that are each individually empty for a different reason — and
  // they KEEP it until the three data-creating steps are done (account logged,
  // position logged, position closed: `checklist.coreComplete`), or until they
  // explicitly skip. Creating the account alone no longer swaps this screen for
  // the grid: that handed a brand-new user exactly the six-empty-widgets view
  // the welcome exists to replace, with two setup steps still outstanding.
  //
  // THE GATE READS THE FULL `useOnboarding` HOOK, which the route already
  // mounts for the checklist's view below, so this costs no extra request: the
  // positions read it derives `coreComplete` from is the same gated read the
  // checklist needs, live for exactly the `pending`/`active` users this gate
  // can apply to. The accounts list is also one the dashboard already needs:
  // `account-balances` is one of the six default widgets and calls `useAccounts`
  // itself, so hoisting the same `['accounts', 'list']` query up here shares one
  // request with it rather than adding a second (Performance NFR). It is read
  // raw — demo rows included — because sample data is the one thing that swaps
  // this screen for the populated grid without completing anything.
  //
  // `skipped` RETIRES THE WELCOME VIEW NOW. It is the explicit way out this
  // gate owes the user: the checklist's dismiss and the welcome card's skip
  // both write it, and a skipped user gets the ordinary dashboard — empty tiles
  // and all — with the "Reopen setup checklist" row `ChecklistSlot` renders on
  // both remaining branches, so the dismissal stays recoverable from here.
  //
  // `enabled: !onboardingRetired` is TRUE on the first render, because the
  // status is unknown until the preference read lands. That is deliberate: the
  // accounts fetch goes out in parallel with the preference and the layout
  // reads rather than waiting a round trip behind one of them. Once the status
  // comes back retired the observer switches off — and by then the response has
  // usually already landed in the cache, where the balances widget picks it up
  // for free. Nothing here is a new blocking request on first paint.
  // ===========================================================================
  const onboarding = useOnboarding();
  const preference = onboarding.preference;
  const onboardingRetired = preference?.status === 'done' || preference?.status === 'skipped';
  const accountsQuery = useAccounts({ enabled: !onboardingRetired });
  const accounts = accountsQuery.data;

  // WHETHER THE CHECKLIST IS ON SCREEN, decided once here rather than left to
  // the component, because on the populated branch it is a grid item and the
  // grid has to be told to make room before anything renders. The rules stay in
  // `resolveChecklistView`; this only reads the answer.
  const checklistView = resolveChecklistView(onboarding);
  const checklistInGrid = checklistView === 'card' || checklistView === 'loading';

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

  // Welcome view — takes precedence over the empty layout below, and sits
  // behind isLoading/isError so neither of those branches changes.
  //
  // NO FLASH IN EITHER DIRECTION, which is the whole reason this waits on every
  // read it consults. Deciding early would be wrong both ways: `checklist` is
  // `undefined` before its reads land, so falling through would show the widget
  // grid to a brand-new user for a beat, and treating "unknown" as "incomplete"
  // would show the welcome to an established user for one. So the route stays
  // on the skeleton it is ALREADY showing until the answer is known, and only
  // then picks a side. Same component as the isLoading branch, so the wait is
  // invisible — the screen does not change twice.
  //
  // A FAILED READ FALLS THROUGH rather than parking on the skeleton forever.
  // Onboarding is presentation over data the dashboard owns anyway; if we cannot
  // tell whether this user is new, the right answer is the dashboard they asked
  // for, not a spinner.
  if (!onboarding.isError && !accountsQuery.isError && !onboardingRetired) {
    if (preference === undefined || accounts === undefined || onboarding.checklist === undefined) {
      return <DashboardSkeleton />;
    }
    // Leaving this screen needs nothing extra: closing the first position
    // invalidates ['positions'], the checklist observer refetches, and the next
    // render falls through to the grid — no reload, no manual swap. Sample data
    // is the other door: the seeder's account arrives on ['accounts'] with
    // `isDemo`, and the populated grid (with the demo banner) is the whole
    // point of asking for it, so it must not be trapped behind the welcome.
    const hasDemoAccount = accounts.some((account) => account.isDemo);
    if (onboarding.checklist !== null && !onboarding.checklist.coreComplete && !hasDemoAccount) {
      return (
        <>
          {/* The header grammar covers the welcome view too — without it a
              fresh user would be the one person with no drawer opener. */}
          <PageHeader page="Dashboard" />
          <ZeroState />
        </>
      );
    }
  }

  // ===========================================================================
  // THE CHECKLIST'S HOME ON EVERY OTHER PATH.
  //
  // `ZeroState` composes `ActivationChecklist` itself, so the welcome branch
  // above needs nothing — and must not double-mount it. But a user reaches
  // these branches with the checklist possibly still live: skipping, adding
  // sample data, and finishing the three core steps with the calculator still
  // untried all land here before the checklist is done. This is where the
  // "Reopen setup checklist" row that keeps a dismissal recoverable lives, and
  // where the retirement that fires on the fourth completed item — which is
  // what finally switches `useOnboarding`'s two expensive gated reads off for
  // good — gets its chance to fire. So both remaining branches mount it.
  //
  // ON THE POPULATED BRANCH IT IS A GRID ITEM. A card above the grid stretched
  // four short rows across the whole content width, with each row's play button
  // a screen away from its label. In the grid it is one widget among the
  // others: locked in the top-right slot, sized like the right-rail widgets
  // below it, with the Stats Summary narrowing to sit beside it. The grid makes
  // the room and takes it back — the stored layout is never written with the
  // checklist in it, and a drag while it is up persists only what the drag
  // moved (`reserveTopRightSlot` / `keepStoredGeometry`). The skeleton and the
  // card occupy the same item, row for row, so the loading swap moves nothing.
  //
  // The reopen row for a `skipped` user is not a grid item — one ghost button
  // is not a widget — and sits above the grid as before. The empty branch has
  // no grid, so the checklist renders as a plain block there, whichever state
  // it is in. On both, the component answers for every state itself and is
  // mounted unconditionally; the route reads `resolveChecklistView` only to
  // choose WHERE, never whether.
  //
  // NO SECOND PRIMARY ACTION. The checklist carries no amber of its own by
  // design, so the one primary each of these views is allowed stays where it is
  // — "Use the default layout" below, and nothing on the populated dashboard.
  // ===========================================================================

  // Empty
  if (widgets.length === 0) {
    return (
      <div className="space-y-6">
        <ChecklistSlot />
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
      {/* THE COACH MARK RIDES WITH THE HEADER, and only on this branch. Widget
          management is what the mark describes — Add Widget, the per-card menu,
          drag and resize, Reset layout — and all of it is on screen here and
          only here. The empty branch has no cards to arrange and no Reset
          layout button, and the zero-state above returns before either. A mark
          also has to stay off a surface the deployment does not offer, but
          there is no deployment gate to consult here: the grid is local layout
          state persisted per user, configured nowhere.

          It is handed to the header rather than placed beside it so that it
          anchors to the HEADING, as every other surface's mark does — see the
          prop's own note. Anchored at the right-hand end of this row it opened
          on top of the checklist's play buttons — which is also why the
          checklist's grid slot is the top-RIGHT one: anchored here, the mark
          opens over the Stats Summary's tiles, and those are not controls. */}
      <DashboardHeader
        placedTypes={placedTypes}
        onAdd={handleAdd}
        onResetLayout={() => {
          void handleUseDefaultLayout();
        }}
        resetBusy={defaultBusy}
        coachMark={<CoachMark surface="dashboard-widgets" />}
      />
      {/* Mounted exactly once on this branch, wherever it goes: in the grid
          when there is a card (or its skeleton) to show, above it otherwise —
          where it renders the reopen row, or nothing. "Nothing" still has to
          mount: the retirement write on the fourth completed item is the
          component's own effect, and a route that skipped the mount for a
          finished checklist would never let it fire. */}
      {checklistInGrid ? null : <ChecklistSlot />}
      <DashboardGrid
        widgets={widgets}
        aside={checklistInGrid ? { ...CHECKLIST_ASIDE, node: <ChecklistSlot /> } : undefined}
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

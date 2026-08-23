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
import { ActivationChecklist } from '@/features/onboarding/components/ActivationChecklist';
import { CoachMark } from '@/features/onboarding/components/CoachMark';
import { ZeroState } from '@/features/onboarding/components/ZeroState';
import { useOnboarding, useOnboardingQuery } from '@/features/onboarding/hooks/useOnboarding';
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
 * The checklist's mount slot on the populated and empty-layout branches.
 *
 * WHY A SLOT AND NOT A BARE MOUNT. `ActivationChecklist` paints a four-row card
 * skeleton while its derived reads are in flight, and the skeleton is SHORTER
 * than the card that replaces it — so on the primary screen the widget grid
 * dropped by the difference, once per load, for every user still mid-onboarding.
 * The design system forbids exactly that — no layout jump between loading,
 * empty and loaded. The checklist itself is correct and is left alone; the
 * geometry is the mount site's problem, and this is the mount site.
 *
 * THE RESERVATION IS DRIVEN BY WHAT ACTUALLY RENDERED, via `:has()` on the
 * skeleton's own test id, rather than by re-deciding here which users get a
 * checklist. That matters twice over: nothing in this file restates the
 * component's rules (a second copy of them is a second thing to get wrong), and
 * the space is reserved ONLY while the skeleton is on screen — not for a retired
 * user who renders nothing, and not for the beat between the last item being
 * ticked and `status: 'done'` landing, where a status-driven reservation would
 * leave an empty box behind.
 *
 * 238px is the settled card's outer height, and it is arithmetic, not a guess:
 * 1px border + 16px (`py-4`) + 44px header (16px `text-base leading-none` title
 * + 8px `gap-2` + 20px `text-sm` description) + 16px (`gap-4`) + 144px content
 * (4 items × `min-h-9`) + 16px + 1px. The skeleton comes to 210px by the same
 * sum, hence the 28px it was short by. If the card's rows, padding or header
 * change, this number changes with them — `_auth.dashboard.test.tsx` pins it so
 * the pair cannot drift silently.
 *
 * `empty:hidden` is not cosmetic. The checklist renders nothing at all for a
 * `done` user — the majority — and a wrapper that stayed in the flow would count
 * as a child of the surrounding `space-y-*`, adding a permanent gap of dead
 * space between the header and the grid that was not there before.
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

  return (
    <div
      data-slot="activation-checklist-slot"
      className="empty:hidden has-data-[testid=activation-checklist-loading]:min-h-[238px]"
    >
      {/* Withdrawn when the tour runtime will not load, exactly as the
          zero-state withdraws it: a "Start" with nothing behind it is a dead
          control, and the checklist is useful without one.

          `canStart` withholds the same thing one set at a time. On THIS screen
          the user has an account, so the account set's first step — the
          zero-state's "Create my first account" — is a control this branch by
          definition does not render. */}
      <ActivationChecklist
        onStartStep={isUnavailable ? undefined : beginGuided}
        canStartStep={canStart}
      />
    </div>
  );
}

function DashboardPage(): ReactElement {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const layout = useDashboardLayout();
  const { data, isLoading, isError, refetch, flushPending, scheduleLayoutWrite } = layout;

  // ===========================================================================
  // THE ZERO-STATE GATE.
  //
  // A user with no accounts gets a screen that tells them what to do instead of
  // six widgets that are each individually empty for a different reason.
  //
  // TWO READS, NOT THREE. `useOnboardingQuery` is the CHEAP preference read; the
  // full `useOnboarding` hook additionally pulls the whole unfiltered positions
  // list down to count it, and this route has no use for a checklist — only for
  // the stored status. The accounts list is the one the dashboard already needs:
  // `account-balances` is one of the six default widgets and calls `useAccounts`
  // itself, so hoisting the same `['accounts', 'list']` query up here shares one
  // request with it rather than adding a second (Performance NFR).
  //
  // `enabled: !onboardingRetired` is TRUE on the first render, because the
  // status is unknown until the preference read lands. That is deliberate: the
  // accounts fetch goes out in parallel with the preference and the layout
  // reads rather than waiting a round trip behind one of them. Once the status
  // comes back `done` the observer switches off — and by then the response has
  // usually already landed in the cache, where the balances widget picks it up
  // for free. Nothing here is a new blocking request on first paint.
  // ===========================================================================
  const onboardingQuery = useOnboardingQuery();
  const preference = onboardingQuery.data;
  // `done` ONLY. `skipped` is a dismissal of the CHECKLIST, not of
  // onboarding: a skipped user with no accounts still has nothing to look at,
  // and the zero-state is where `ActivationChecklist` — hence the product's only
  // "Reopen setup checklist" control — is mounted. Retiring on `skipped` would
  // delete that control from the product and make dismissal unrecoverable.
  const onboardingRetired = preference?.status === 'done';
  const accountsQuery = useAccounts({ enabled: !onboardingRetired });
  const accounts = accountsQuery.data;

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

  // Zero state — takes precedence over the empty layout below, and sits behind
  // isLoading/isError so neither of those branches changes.
  //
  // NO FLASH IN EITHER DIRECTION, which is the whole reason this is three
  // conditions and not one. Deciding early would be wrong both ways: `accounts`
  // is `undefined` before it lands, so `accounts?.length === 0` would show the
  // zero-state to every established user for a beat; and falling through while
  // the status is unknown would show the widget grid to a brand-new user for a
  // beat. So the route stays on the skeleton it is ALREADY showing until both
  // reads have answered, and only then picks a side. Same component as the
  // isLoading branch, so the wait is invisible — the screen does not change
  // twice.
  //
  // A FAILED READ FALLS THROUGH rather than parking on the skeleton forever.
  // Onboarding is presentation over data the dashboard owns anyway; if we cannot
  // tell whether this user is new, the right answer is the dashboard they asked
  // for, not a spinner.
  if (!onboardingQuery.isError && !accountsQuery.isError && !onboardingRetired) {
    if (preference === undefined || accounts === undefined) {
      return <DashboardSkeleton />;
    }
    // Leaving this screen on the first account needs nothing extra:
    // `useCreateAccount` invalidates ['accounts'], this observer refetches, and
    // the next render falls through to the grid — no reload, no manual swap.
    if (accounts.length === 0) {
      return (
        <>
          {/* The header grammar covers the zero state too — without it a
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
  // `ZeroState` composes `ActivationChecklist` itself, so the zero-state branch
  // above needs nothing — and must not double-mount it. But the zero-state is
  // the ONLY screen the checklist had, and a user leaves it the instant they
  // create their first account. That is precisely when items 2-4 (size a trade,
  // log a position, close it) become the outstanding work, when the "Reopen
  // setup checklist" row that keeps a dismissal recoverable would otherwise be
  // unreachable, and when the retirement that fires on the fourth completed
  // item — which is what finally switches `useOnboarding`'s two expensive gated
  // reads off for good — would never get a chance to fire. So both remaining
  // branches mount it.
  //
  // UNCONDITIONALLY, and that is safe because the component answers for every
  // state itself: nothing for a retired (`done`) user, nothing while the stored
  // status is still unknown, the quiet reopen row for a `skipped` user, and the
  // card otherwise. Nothing here may restate those rules — a second copy of them
  // is a second thing to get wrong.
  //
  // NO LAYOUT JUMP, and it takes all three of these. `ActivationChecklist`
  // occupies no space while `preference` is `undefined`, so it cannot appear and
  // then vanish on an established user; this route never even reaches these
  // branches with an unknown status unless a read failed, because the gate above
  // holds the skeleton until the preference lands; and `ChecklistSlot` reserves
  // the settled card's height for the one transition the first two do not cover,
  // the skeleton → card swap a mid-onboarding user still sees. Mount through the
  // slot, never `ActivationChecklist` directly.
  //
  // NO SECOND PRIMARY ACTION. The checklist carries no amber of its own by
  // design, so the one primary each of these views is allowed stays where it is
  // — "Use the default layout" below, and nothing on the populated dashboard.
  // The per-item "Start" buttons `ChecklistSlot` now wires are ghost-variant and
  // change none of that; they were left unwired only while the walkthrough
  // itself was still to be built.
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
          on top of the checklist's play buttons. */}
      <DashboardHeader
        placedTypes={placedTypes}
        onAdd={handleAdd}
        onResetLayout={() => {
          void handleUseDefaultLayout();
        }}
        resetBusy={defaultBusy}
        coachMark={<CoachMark surface="dashboard-widgets" />}
      />
      {/* Above the grid, below the page heading and its actions — see the note
          on the empty branch. */}
      <ChecklistSlot />
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

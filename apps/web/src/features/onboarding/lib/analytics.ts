// The onboarding funnel's five events, and the only shape they are allowed to
// take (R8).
//
// THE POINT OF THE FILE IS THE TYPE, NOT THE FUNCTION. R8.5 says an onboarding
// event carries no position, symbol, balance or monetary value, and the cheapest
// way to break that rule is a helper that takes `Record<string, unknown>` — the
// first caller with a position id to hand puts it in, nobody notices, and the
// rule is now a comment. So there is no property bag: `OnboardingEvent` is a
// closed discriminated union in which every event names its own properties, and
// every one of those is a checklist item id, a tour exit reason, or a step
// ordinal. A caller CANNOT attach anything else without editing this union,
// which is a visible change to a file whose whole subject is what may be sent.
//
// The values are as narrow as the domain allows: `item` is one of the four
// `ChecklistItemId` literals, `reason` is one of the two non-completing
// `TourExitReason` literals, and the two numbers are an index into a step array
// and its length. Nothing here is free text, so there is no field a price or a
// ticker could be spelled into.
//
// EMISSION IS INVISIBLE TO THE FLOW. `captureClientEvent` already does nothing
// when PostHog was never initialized — the default self-hosted case (R8.4) — so
// there is deliberately no configured-check here; a second one could only drift
// out of agreement with the first. What that helper does NOT do is guard against
// the vendor SDK throwing, and these calls sit inside a tour's exit handler and a
// query effect, where a throw would take the teardown or the render with it. So
// every emission is wrapped and every failure is swallowed: a walkthrough must
// end the same way whether or not anyone is counting.
//
// NO NEW VENDOR AND NO SECOND SDK (R8.3): the one import below is the telemetry
// module the rest of the app already captures through.

import { captureClientEvent } from '@/lib/telemetry/posthog';
import { eventBus } from '@/stores/event-bus.store';

import type { Checklist, ChecklistItemId } from './derive-checklist';
import type { TourExitReason } from './tour-engine';

/**
 * Every onboarding event, with its full payload. Adding a property here is the
 * only way to widen what an onboarding event can carry — see the note above
 * before doing so.
 *
 * `stepIndex` is zero-based into the running set, and is `-1` when the tour ended
 * before any step was ever highlighted (a first target that never appeared).
 */
export type OnboardingEvent =
  | { name: 'onboarding_walkthrough_offered'; item: ChecklistItemId }
  | { name: 'onboarding_walkthrough_started'; item: ChecklistItemId; stepCount: number }
  | { name: 'onboarding_walkthrough_completed'; item: ChecklistItemId; stepCount: number }
  | {
      name: 'onboarding_walkthrough_abandoned';
      item: ChecklistItemId;
      stepIndex: number;
      stepCount: number;
      // `target-missing` is an abandonment the user did not choose (R5.4). It is
      // carried as a reason rather than a sixth event name so the funnel counts
      // both kinds of not-finishing together and can still tell them apart.
      reason: Exclude<TourExitReason, 'completed'>;
    }
  | { name: 'onboarding_checklist_item_completed'; item: ChecklistItemId };

/** Send one onboarding event. Never throws, never blocks, never returns a result. */
export function emitOnboardingEvent(event: OnboardingEvent): void {
  const { name, ...properties } = event;
  try {
    captureClientEvent(name, properties);
  } catch {
    // Telemetry is not allowed to change what the user sees. A capture that
    // throws is dropped here rather than unwinding a tour teardown or a render.
  }
}

// ---------------------------------------------------------------------------
// Checklist item completion (R8.2)
// ---------------------------------------------------------------------------

/**
 * The item ids already known to be complete, or `null` before the first
 * checklist has been seen.
 *
 * MODULE-SCOPED, AND IT HAS TO BE. `useOnboarding` is mounted three times over
 * on the zero-state screen — by `ZeroState`, by the `ActivationChecklist` inside
 * it, and by `useWalkthrough` — and each instance derives its own `Checklist`
 * object from the same shared query data. A per-instance ref would report the
 * same completion once per mounted copy.
 */
let reportedDone: Set<ChecklistItemId> | null = null;

/**
 * Emit an event for each item that has just BECOME complete, and nothing for the
 * items that already were.
 *
 * Completion is derived from counts rather than stored (R4.2), so "is it done?"
 * is answerable on every render and the naive effect fires forever. The first
 * checklist observed therefore only establishes the baseline: a user who signed
 * up last month and reloads the dashboard has four complete items and has just
 * completed none of them. From then on, an id present now and absent from the
 * baseline is a real transition.
 *
 * `null` and `undefined` are not observations. `undefined` is "not known yet"
 * and `null` is "this user has no checklist" (dismissed or retired) — neither is
 * a checklist in which nothing is done, and treating either as one would replay
 * every completion when the checklist came back.
 *
 * Nothing seeded fires: `useOnboarding` excludes the sample account and its rows
 * from the counts (R4.8/R9), so adding demo data completes no item and there is
 * no transition here to notice.
 */
export function reportChecklistCompletions(checklist: Checklist | null | undefined): void {
  if (!checklist) return;

  const done = new Set(checklist.items.filter((item) => item.done).map((item) => item.id));
  const baseline = reportedDone;
  // Adopt the new baseline BEFORE emitting, so the effect running in the second
  // mounted copy on the same commit finds nothing left to report.
  reportedDone = done;
  if (baseline === null) return;

  for (const id of done) {
    if (!baseline.has(id)) {
      emitOnboardingEvent({ name: 'onboarding_checklist_item_completed', item: id });
    }
  }
}

/**
 * Forget the baseline when the session ends.
 *
 * The baseline outlives any component, so without this the next user to log in
 * on the same tab inherits the last one's — and every item THEY had already
 * completed, which the departing user had not, would be reported as a fresh
 * completion. Subscribed at module scope for the same reason `useWalkthrough`
 * subscribes to this event at module scope: the state being dropped is not
 * owned by anything that is mounted. The bus holds handlers in a `Set`, so
 * re-arming is a no-op.
 */
function forgetBaselineOnLogout(): void {
  reportedDone = null;
}

function armLogoutReset(): void {
  // A named handler, not an inline arrow: the bus dedupes by function identity,
  // so re-arming with a fresh closure would stack a second listener each time.
  eventBus.subscribe('auth:logout', forgetBaselineOnLogout);
}

armLogoutReset();

/** Test seam: drop the completion baseline and restore the import-time listener. */
export function __resetOnboardingAnalyticsForTests(): void {
  reportedDone = null;
  armLogoutReset();
}

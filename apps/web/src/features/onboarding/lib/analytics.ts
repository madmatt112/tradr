// The onboarding funnel's five events, and the only shape they are allowed to
// take.
//
// THE POINT OF THE FILE IS THE TYPE, NOT THE FUNCTION. An onboarding event may
// carry no position, symbol, balance or monetary value, and the cheapest way to
// break that rule is a helper that takes `Record<string, unknown>` — the first
// caller with a position id to hand puts it in, nobody notices, and the rule is
// now a comment. So there is no property bag: `OnboardingEvent` is a closed
// discriminated union in which every event names its own properties, and every
// one of those is a checklist item id, a tour exit reason, or a step ordinal. A
// caller CANNOT attach anything else without editing this union, which is a
// visible change to a file whose whole subject is what may be sent.
//
// The values are as narrow as the domain allows: `item` is one of the four
// `ChecklistItemId` literals, `reason` is one of the three non-completing
// `TourExitReason` literals, and the two numbers are an index into a step array
// and its length. Nothing here is free text, so there is no field a price or a
// ticker could be spelled into.
//
// EMISSION IS INVISIBLE TO THE FLOW. `captureClientEvent` already does nothing
// when PostHog was never initialized — the default self-hosted case — so there
// is deliberately no configured-check here; a second one could only drift out of
// agreement with the first. What that helper does NOT do is guard against the
// vendor SDK throwing, and these calls sit inside a tour's exit handler and a
// query effect, where a throw would take the teardown or the render with it. So
// every emission is wrapped and every failure is swallowed: a walkthrough must
// end the same way whether or not anyone is counting.
//
// NO NEW VENDOR AND NO SECOND SDK: the one import below is the telemetry module
// the rest of the app already captures through.

import { captureClientEvent } from '@/lib/telemetry/posthog';
import { eventBus } from '@/stores/event-bus.store';
import type { AccountChangeReason, PositionChangeReason } from '@/stores/events.types';

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
      // `target-missing` and `session-ended` are abandonments the user did not
      // choose; `dismissed` is the one they did. They are carried as a reason
      // rather than as three more event names so the funnel counts every kind
      // of not-finishing together and can still tell them apart — which is the
      // point of the distinction: the funnel exists to find where users stop,
      // and "declined the walkthrough" is a different answer from "left the
      // app".
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
// Checklist item completion
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
 * How much of each item's completion this tab actually WATCHED happen: the net
 * number of completing writes seen since the session began.
 *
 * The baseline below cannot, on its own, tell an item the user completed a
 * minute ago on another route from one they completed last month: both are
 * simply `done` in the first checklist the dashboard derives, and the
 * baseline-only rule throws both away. That silently drops real first-time
 * completions — for the user who created their account on `/accounts` and only
 * then opened the dashboard, item 1 never happened as far as the funnel is
 * concerned, which biases exactly the measurement the funnel exists to produce.
 *
 * THE SERVER CANNOT SETTLE IT, AND DELIBERATELY SO. Per-item completion is
 * derived, never stored — `packages/shared/src/schemas/onboarding.ts` says in
 * as many words that adding `accountCreated` or `positionLogged` to the
 * preference is the bug its comment exists to stop, and the checklist reads
 * counts rather than timestamps precisely so completion cannot disagree with
 * reality. So there is no server-side "already complete when this session
 * began" to prefer, and inventing one would trade a measurement bias for a
 * second source of truth about the user's own data.
 *
 * What there IS, server-confirmed, is the write itself. `accounts:` and
 * `positions:cache-invalidate` are published only once the server accepted a
 * mutation — the same signals `useWalkthrough` already trusts to advance an
 * action step.
 *
 * A COUNT, NOT A FLAG, AND THAT IS THE WHOLE OF IT. "This tab watched a write
 * for item X" is not "item X was completed in this session": a user with three
 * accounts who adds a fourth on `/accounts` before ever opening the dashboard
 * has watched a `created` land on an item they finished months ago, and a flag
 * would report it as a fresh completion. What separates the two is arithmetic
 * the checklist's own inputs already hold: the item is a completion of THIS
 * session only if the rows behind it are rows this tab watched appear. One
 * account and one watched `created` is the first account; four accounts and one
 * watched `created` is a user who arrived with three.
 *
 * `reopened` counts DOWN for the same reason it counts down in the checklist:
 * it takes a position back out of the closed set, so a reopen-and-re-close
 * leaves the net at zero and reports nothing — which is right, because the
 * item was already done before either happened.
 *
 * Nothing seeded can fire through this. The sample-data seeder publishes
 * `demo-seeded`, never `created`, and `useOnboarding` excludes its rows from
 * every count — a watched item that never becomes `done` is never emitted.
 *
 * THE HONEST LIMITS, all of them in the same direction (a real completion goes
 * unreported; none is invented):
 *   - a completion in a tab that reloaded before the checklist was ever derived
 *     leaves no trace, and recovering it would mean writing progress to the
 *     client, which is ruled out because a stored copy could disagree with the
 *     counts the checklist derives from;
 *   - a CSV import publishes no `positions:cache-invalidate` at all
 *     (`useCsvCommit` invalidates the queries directly), so positions that
 *     arrive that way are counted by the checklist and watched by nothing;
 *   - a delete lowers an item's count without saying what it removed — the
 *     event carries a reason, not a status — so rows deleted before the first
 *     observation are not subtracted here.
 * In each case the count falls short of the item's rows and the first
 * observation baselines it away, exactly as it did before any of this existed.
 */
const watchedCompletions = new Map<ChecklistItemId, number>();

function watch(item: ChecklistItemId, delta: number): void {
  watchedCompletions.set(item, (watchedCompletions.get(item) ?? 0) + delta);
}

/**
 * Arm a completion the event bus cannot announce.
 *
 * Item 2 is the one with no `cache-invalidate` behind it: the calculator is
 * stateless, so its only data trace is the `calculatorFirstUsedAt` timestamp,
 * and writing that timestamp IS the event. Called from `useOnboardingPatch`,
 * for a patch that carried it — which the calculator sends exactly once, when
 * the stored value is absent, so unlike the row-backed items it cannot be a
 * repeat and has no count to be checked against.
 */
export function armChecklistCompletion(item: ChecklistItemId): void {
  watch(item, 1);
}

function armFromAccountChange({ reason }: { reason: AccountChangeReason }): void {
  if (reason === 'created') watch('account', 1);
}

function armFromPositionChange({ reason }: { reason: PositionChangeReason }): void {
  if (reason === 'created') watch('position', 1);
  else if (reason === 'closed') watch('close', 1);
  else if (reason === 'reopened') watch('close', -1);
}

/**
 * A checklist as the user's data made it, and the counts it was made from.
 *
 * The two travel together because the first observation needs both and they
 * must be of the same moment: `checklist` says which items are done, `counts`
 * says how many of the user's own rows stand behind each of the three that are
 * row-backed (item 2, the calculator, has no rows — see `armChecklistCompletion`).
 * `useOnboarding` derives them in one pass, so they cannot be a checklist from
 * one render and counts from another.
 */
export interface ChecklistObservation {
  checklist: Checklist;
  counts: Record<Exclude<ChecklistItemId, 'calculator'>, number>;
}

/**
 * Whether every row behind `id` is a row this tab watched appear — the test
 * that separates an item completed during this session from one the user
 * arrived with. `true` for the calculator on any watched write, because its
 * one signal is sent once and never repeats.
 */
function completedThisSession(id: ChecklistItemId, counts: ChecklistObservation['counts']) {
  const watched = watchedCompletions.get(id) ?? 0;
  if (watched <= 0) return false;
  return id === 'calculator' || watched >= counts[id];
}

/**
 * Emit an event for each item that has just BECOME complete, and nothing for the
 * items that already were.
 *
 * Completion is derived from counts rather than stored, so "is it done?" is
 * answerable on every render and the naive effect fires forever. The first
 * checklist observed therefore establishes the baseline: a user who signed up
 * last month and reloads the dashboard has four complete items and has just
 * completed none of them. From then on, an id present now and absent from the
 * baseline is a real transition.
 *
 * The one thing the first checklist does NOT baseline away is an item this
 * session watched the user complete — see `watchedCompletions` above for why the
 * two cases have to be told apart, why the bus is what tells them, and why it
 * takes a count to do it rather than a flag.
 *
 * `null` and `undefined` are not observations. `undefined` is "not known yet"
 * and `null` is "this user has no checklist" (dismissed or retired) — neither is
 * a checklist in which nothing is done, and treating either as one would replay
 * every completion when the checklist came back.
 *
 * Nothing seeded fires: `useOnboarding` excludes the sample account and its rows
 * from the counts, so adding demo data completes no item and there is no
 * transition here to notice.
 */
export function reportChecklistCompletions(
  observation: ChecklistObservation | null | undefined,
): void {
  if (!observation) return;
  const { checklist, counts } = observation;

  const done = new Set(checklist.items.filter((item) => item.done).map((item) => item.id));
  const baseline = reportedDone;
  // Adopt the new baseline BEFORE emitting, so the effect running in the second
  // mounted copy on the same commit finds nothing left to report.
  reportedDone = done;

  // On the first observation the baseline has no opinion, so what this tab
  // watched is the only evidence of a transition. Consumed here: from the next
  // observation on, the baseline itself tells the same story and reading both
  // could double an event.
  const isNew =
    baseline === null
      ? (id: ChecklistItemId) => completedThisSession(id, counts)
      : (id: ChecklistItemId) => !baseline.has(id);

  for (const id of done) {
    if (isNew(id)) {
      emitOnboardingEvent({ name: 'onboarding_checklist_item_completed', item: id });
    }
  }
  if (baseline === null) watchedCompletions.clear();
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
  // The watched writes belong to the departing user too. Left behind, they
  // would let the NEXT user's first checklist emit their already-done items as
  // fresh completions — the very attribution bug the baseline reset closes.
  watchedCompletions.clear();
}

function armBusListeners(): void {
  // Named handlers, not inline arrows: the bus dedupes by function identity, so
  // re-arming with a fresh closure would stack a second listener each time.
  eventBus.subscribe('auth:logout', forgetBaselineOnLogout);
  eventBus.subscribe('accounts:cache-invalidate', armFromAccountChange);
  eventBus.subscribe('positions:cache-invalidate', armFromPositionChange);
}

armBusListeners();

/** Test seam: drop the completion state and restore the import-time listeners. */
export function __resetOnboardingAnalyticsForTests(): void {
  reportedDone = null;
  watchedCompletions.clear();
  armBusListeners();
}

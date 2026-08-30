// useWalkthrough — the guided walkthrough's whole behaviour.
//
// It composes three things that were built separately and deliberately know
// nothing about each other: `lib/tour-engine.ts` (mechanics), `lib/steps/`
// (content), and `useOnboarding` (the user's real data). Everything below is
// the glue, and every rule it enforces is load-bearing.
//
// THE RUNTIME IS LOADED DYNAMICALLY, AND THAT IS THE POINT. Both
// `lib/tour-engine` and `lib/steps` are reached ONLY through `import()` inside
// `run()` below — never a top-level import. `tour-engine` is the sole module
// that pulls in `driver.js` and `tour.css`, so a static edge from here would put
// the whole tour runtime into the dashboard route's initial chunk, which every
// returning user pays for and no returning user uses. Type-only imports are
// fine: they erase. This property is now enforced, not merely intended —
// `apps/web/scripts/check-bundle-size.mjs` fails the build if a driver.js marker
// appears in the entry chunk.
//
// THE SESSION IS MODULE-SCOPED, NOT COMPONENT-SCOPED. A walkthrough crosses
// routes: the position set starts on `/positions` and finishes on
// `/positions/$positionId`, and the close set ends up back on `/dashboard`. The
// component that started it (`ZeroState`, on the dashboard) unmounts on the
// first of those navigations. If `isRunning`, the current step and the event
// subscription lived in component state they would all die there, mid-tour,
// while driver.js — whose own state is module-scoped — carried on painting an
// overlay nothing was driving. So the session lives in a store next to the
// engine's own module state, and the hook is a thin binding onto it. It is also
// what lets a component on a completely different route ask `isRunning` (the
// coach marks are suppressed while a walkthrough runs).
//
// NOTHING AUTO-STARTS. Mounting this hook has no effect whatsoever; `start()`
// is a user action, called from the zero-state's "Walk me through it" and the
// checklist's per-item buttons. There is no effect that reads the stored status
// and begins a tour, and there must never be one.
//
// RESUME IS JUST `start()` WITH NO ARGUMENT. After a reload there is no step
// index to restore because none was ever stored — `nextIncompleteItem()`
// re-derives the set from the checklist, which is itself derived from the
// user's accounts and positions. A user who reloads after creating their
// account resumes at the calculator set because their data says the account
// step is done, not because we wrote that down. Storing an index would be a
// second source of truth that could disagree with the first, and the first is
// the one that is right.
//
// EXITING DISCARDS NOTHING, and it is structural rather than careful: this
// module never writes onboarding state at all. The opt-in record
// (`status: 'active'`) is the caller's, written when the user chooses to be
// guided; completion is derived. So there is nothing an exit — by the close
// button, Escape, an unresolvable target or a failed chunk load — could roll
// back. The checklist after a walkthrough is the same checklist as before it,
// plus whatever the user actually did.

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';

import { accountsListQuery, useAccounts } from '@/features/accounts/hooks/useAccounts';
import { positionsListQuery, usePositions } from '@/features/positions/hooks/usePositions';
import { eventBus } from '@/stores/event-bus.store';
import type { EventName } from '@/stores/events.types';

import { emitOnboardingEvent } from '../lib/analytics';
import type { ChecklistItemId, Checklist } from '../lib/derive-checklist';
import type { WalkthroughStep } from '../lib/steps';
import type { TourBlock } from '../lib/tour-engine';

import { selectOwnRows, useOnboarding } from './useOnboarding';

type TourEngineModule = typeof import('../lib/tour-engine');
type StepsModule = typeof import('../lib/steps');

/**
 * The real event that completes an action step, keyed by the step's target
 * selector.
 *
 * KEYED BY TARGET, NOT BY INDEX, on purpose. The selectors are the step data's
 * own stable identity — `steps.test.ts` already fails if one is renamed or stops
 * matching anything the app renders — whereas an index would silently point at
 * the wrong step the first time a set gains a paragraph. `[data-tour=
 * "position-add-fill"]` appears in two sets and means the same thing in both,
 * which is exactly the behaviour keying by target gives for free.
 *
 * A step marked `advanceOnAction` whose action is NOT in here is handled by
 * `withObservableActionsOnly()` below — see the note there.
 *
 * 'closed' IS PUBLISHED BY THE EXIT FILL AS WELL AS BY THE CLOSE BUTTON, and the
 * close step depends on it. An exit that leaves nothing open closes the position
 * server-side, in the same request that records the fill, so the button that
 * step highlights is gone before anyone could press it. `useAddFill` publishes
 * the close it was told about, which is what carries the tour past that step —
 * the walkthrough learns about the state change rather than the product being
 * bent to produce one it can see.
 */
export const ACTION_SIGNALS: Readonly<Record<string, { event: EventName; reason: string }>> = {
  '[data-tour="account-submit"]': { event: 'accounts:cache-invalidate', reason: 'created' },
  '[data-tour="position-submit"]': { event: 'positions:cache-invalidate', reason: 'created' },
  '[data-tour="position-add-fill"]': { event: 'positions:cache-invalidate', reason: 'fill-added' },
  '[data-tour="position-open"]': { event: 'positions:cache-invalidate', reason: 'opened' },
  '[data-tour="position-close"]': { event: 'positions:cache-invalidate', reason: 'closed' },
};

interface WalkthroughStoreState {
  isRunning: boolean;
  /** The runtime failed to load and this session gave up on it. */
  isUnavailable: boolean;
  /** Which checklist item's set is running, or `null`. */
  itemId: ChecklistItemId | null;
  currentStep: WalkthroughStep | null;
  stepIndex: number;
}

const IDLE: Omit<WalkthroughStoreState, 'isUnavailable'> = {
  isRunning: false,
  itemId: null,
  currentStep: null,
  stepIndex: -1,
};

/**
 * Session state, module-scoped for the reason given at the top of the file.
 * Exported for tests only — components go through `useWalkthrough()`.
 */
export const useWalkthroughStore = create<WalkthroughStoreState>(() => ({
  ...IDLE,
  isUnavailable: false,
}));

// The rest of the session: the steps being driven and the event subscriptions
// driving them. Plain module variables rather than store fields — nothing
// renders from them, and putting them in the store would re-render every
// consumer for a change no consumer can see.
let activeSteps: WalkthroughStep[] = [];
/**
 * The values this session's parameterised routes need, as they stand NOW.
 *
 * Mutable for the whole of the session rather than fixed at `start()`, because
 * the one value that matters most is not knowable then: the position set opens
 * on `/positions` and finishes on the detail page of a position the user has not
 * created yet. That id arrives on the event that advances the step, and
 * `bindAdvance` merges it in — see the note there.
 */
let activeParams: Record<string, string> | undefined;
let unsubscribers: (() => void)[] = [];
let enginePromise: Promise<[TourEngineModule, StepsModule]> | null = null;

function endSession(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
  activeSteps = [];
  activeParams = undefined;
  useWalkthroughStore.setState(IDLE);
}

/**
 * Logging out ends the walkthrough, overlay and all.
 *
 * The session is module-scoped for the reason at the top of this file, which
 * means `queryClient.clear()` in `useAuth` does not touch it: without this the
 * next user to log in on the same tab would inherit the last one's tour. We
 * listen for `auth:logout` on the event bus rather than exporting something for
 * `useAuth` to call, so auth keeps knowing nothing about onboarding.
 *
 * Subscribed at MODULE scope, not from the hook: a walkthrough deliberately
 * outlives the component that started it, so the teardown has to outlive it too
 * — and a stale `isUnavailable` belongs to the departing session even when no
 * tour is running. The bus stores handlers in a `Set`, so re-arming is a no-op.
 */
function teardownOnLogout(): void {
  // THE ENGINE GOES DOWN BEFORE THE SESSION DOES, AND THE ORDER IS THE POINT.
  // `engine.stop()` fires `onExit`, and `onExit` builds the abandonment event
  // out of the LIVE session — the step the user was on, and the size of the set
  // it was a step of. Clearing the session first would hand the funnel
  // `stepIndex: -1` in a tour of `stepCount: 0` for every user who ever logs
  // out mid-walkthrough: "abandoned at no step, of nothing", which destroys
  // precisely the measurement the funnel exists to produce.
  //
  // A session ending IS a place a user stopped, so it is reported rather than
  // suppressed — under `session-ended`, its own reason. It used to arrive as
  // `dismissed`, which also means "the user turned the walkthrough down", and
  // the funnel exists to find where users stop: one that cannot tell someone
  // who declined the tour from someone whose session went away under them has
  // blurred the one thing it was built to see.
  //
  // `onExit` runs `endSession()` itself, so the teardown below is for the tour
  // that was NOT running: a session whose runtime never loaded, and a stale
  // `isUnavailable` belonging to the departing user. The engine is only
  // reachable once its chunk has loaded, and a tour can only be running if it
  // has, so the deferred branch is also the only one that can have a tour.
  if (enginePromise) {
    void enginePromise
      .then(([engine]) => engine.stop('session-ended'))
      .catch(() => {})
      .finally(finishLogoutTeardown);
    return;
  }
  finishLogoutTeardown();
}

function finishLogoutTeardown(): void {
  endSession();
  useWalkthroughStore.setState({ ...IDLE, isUnavailable: false });
}

function armLogoutTeardown(): void {
  eventBus.subscribe('auth:logout', teardownOnLogout);
}

armLogoutTeardown();

/**
 * Load the tour runtime and the step content, together and lazily.
 *
 * A rejection here is an ordinary outcome, not an exception. The chunk can 404
 * after a deploy, be blocked, or simply be unreachable offline. We mark the
 * walkthrough unavailable, leave the stored onboarding status ALONE — the user
 * has not skipped anything and must not be recorded as having done so — and
 * return `null`. The zero-state and checklist are untouched by all of this and
 * keep working, which is the whole point: the unguided path is the fallback,
 * and it is the same path everyone else uses.
 *
 * The promise is cached on success and dropped on failure, so a later retry
 * genuinely retries rather than re-awaiting the rejection.
 */
async function loadRuntime(): Promise<[TourEngineModule, StepsModule] | null> {
  try {
    enginePromise ??= Promise.all([import('../lib/tour-engine'), import('../lib/steps')]);
    return await enginePromise;
  } catch (err) {
    enginePromise = null;
    console.error('[onboarding] the guided walkthrough could not be loaded', err);
    useWalkthroughStore.setState({ ...IDLE, isUnavailable: true });
    return null;
  }
}

/**
 * Subscribe to the events that advance this session's action steps.
 *
 * The current step decides: an event only advances the tour when the step on
 * screen is an action step AND the event is the one that step's action produces.
 * Every other event on the bus — a position updated elsewhere, a fill deleted —
 * passes through without touching the tour.
 */
function bindAdvance(engine: TourEngineModule, navigate: NavigateFn): void {
  const advanceOn = (event: EventName) => (payload: { reason: string; positionId?: string }) => {
    const { currentStep: step, stepIndex } = useWalkthroughStore.getState();
    if (!step?.advanceOnAction || step.target === undefined) return;
    const signal = ACTION_SIGNALS[step.target];
    if (signal?.event !== event || signal.reason !== payload.reason) return;
    // THE ROUTE VALUE THE NEXT STEP NEEDS ARRIVES ON THE EVENT, AND THERE IS
    // NOWHERE ELSE IT COULD COME FROM. The position set's third step lives on
    // `/positions/$positionId` — the page of the position the user made two
    // steps ago — and nothing knew that id when the tour started, because the
    // position did not exist. The bus already carries it: every publisher of
    // `positions:cache-invalidate` names the row it is about. Folding it into
    // the session's params here is what lets the navigation below work at all;
    // without it the set stops dead on `/positions`, where the next step's
    // target never appears, and steps 3 to 5 are unreachable.
    //
    // Merged rather than replaced, so a value the caller supplied for a
    // DIFFERENT param survives, and so a later event about the same position
    // is a no-op rather than a change.
    if (payload.positionId !== undefined) {
      activeParams = { ...activeParams, positionId: payload.positionId };
    }
    // BEFORE the tour moves, never after. A set can change screen mid-way —
    // the close set ends on `/dashboard`, whose grid is the last thing it
    // shows the user, and the position set moves onto the position that was
    // just created — and nothing else is going to put them there: the overlay
    // is up, so the sidebar is not theirs to click. The engine's step-change
    // callback is too late to do it from, because driver.js only calls it once
    // it has RESOLVED the step's target, which for a target that never appears
    // is after `waitForMs` has expired and the tour has already given up.
    // Navigating here means the new route is mounting while that window is
    // still open, exactly as it is for the first step of a set.
    navigateBetweenSteps(step, activeSteps[stepIndex + 1], activeParams, navigate);
    engine.advance();
  };

  unsubscribers = [
    eventBus.subscribe('positions:cache-invalidate', advanceOn('positions:cache-invalidate')),
    eventBus.subscribe('accounts:cache-invalidate', advanceOn('accounts:cache-invalidate')),
  ];
}

/**
 * Hand the engine the steps it should gate on an action, and only those.
 *
 * A step marked `advanceOnAction` does not advance on "Next" — the engine
 * suppresses it — so a step whose action produces no event we can observe would
 * strand the user with a live tour and no way forward but Escape. Four of the
 * authored action steps are like that: their "action" is a pure UI gesture
 * (opening the account dialog, opening the new-position dialog, choosing the
 * Percent risk basis, picking an account in the calculator) which changes no
 * server data and publishes nothing.
 *
 * For those the flag is turned off, and `appearanceSignal()` below then says
 * what the step advances on instead. The highlighted control stays interactive
 * throughout (`disableActiveInteraction: false`), so the gesture is always the
 * user's to make.
 *
 * "NEXT ADVANCES THEM" WAS THE PREVIOUS ANSWER, AND ON TWO OF THE FOUR IT WAS
 * NOT TRUE. Turning the flag off hands "Next" back, but "Next" can only move a
 * tour onto a step whose target exists — and the first step of the account set
 * and of the position set both name a field inside a dialog the user has not
 * opened. Pressing it moved driver.js onto that step, which then sat in its
 * `waitForElement` window with the PREVIOUS popover still on screen for the full
 * 15 seconds before ending the walkthrough. Reported as "the next button does
 * nothing", against both sets, and correctly: it did nothing a user could see,
 * for fifteen seconds, and then took the walkthrough away.
 *
 * So the gesture's own result is the signal. The dialog opening IS the step's
 * action, observed in the DOM instead of on the bus, and the engine holds "Next"
 * until it lands exactly as it does for an action step with an event behind it.
 * The other two of the four keep advancing on "Next" as they always did, because
 * the control their next step names is already on the screen they run on.
 */
function withObservableActionsOnly(steps: WalkthroughStep[]): WalkthroughStep[] {
  return steps.map((step, index) => {
    if (!step.advanceOnAction) return step;
    if (step.target !== undefined && step.target in ACTION_SIGNALS) return step;
    return {
      ...step,
      advanceOnAction: false,
      advanceOnAppearanceOf: appearanceSignal(step, steps[index + 1]),
    };
  });
}

/**
 * The control whose ARRIVAL is this step's action, when there is one.
 *
 * The four steps above ask for a gesture with no event behind it, but two of
 * them — "Choose New Account" and "Choose New Position" — do leave a mark we can
 * see: the dialog they open, which is where the NEXT step's target lives. Naming
 * it here is what turns those two from steps driven by a "Next" that cannot work
 * into steps driven by the gesture their own copy asks for, and it is why the
 * flag being off above no longer means "Next is the only way on".
 *
 * TWO KINDS OF NEXT STEP ARE REFUSED, AND THE FIRST IS THE ONE THAT MATTERS:
 *
 * - A NEXT STEP ON ANOTHER ROUTE is reached by NAVIGATING, and nothing navigates
 *   until the tour moves. Waiting for its target would be waiting for something
 *   the wait itself prevents — a step with no way out but Escape, which is the
 *   trap the downgrade above exists to avoid. No step is in that position today:
 *   all four run their gesture and their next step on one screen. It is a guard
 *   for the fifth, because the failure it prevents is silent and the check is one
 *   comparison.
 * - A NEXT STEP WITH NO TARGET is centred, so there is nothing to wait for.
 *
 * The calculator's two gesture steps are named here and cost nothing: both point
 * at a control `/calculator` already renders, so the engine finds the selector
 * present, leaves the gate open and lets "Next" move them exactly as before.
 */
function appearanceSignal(
  step: WalkthroughStep,
  next: WalkthroughStep | undefined,
): string | undefined {
  if (next?.target === undefined) return undefined;
  if (next.route !== step.route) return undefined;
  return next.target;
}

/**
 * Whether a set can actually START from where the user's data has them.
 *
 * A set whose FIRST step targets a control that is not on screen — and that
 * nothing is going to navigate to — waits out its `waitForMs` and exits
 * `target-missing` without a word. To the user that is a button that did
 * nothing, which is the failure this branch has already shipped twice. So the
 * checklist ASKS before it offers a shortcut, and withholds the ones that cannot
 * run rather than putting a dead control on screen.
 *
 * BOTH DOORS ASK IT, and they differ only in when they can. The permanent entry
 * point in settings has no mounted reads to answer from, so it asks at the click
 * (`resolveStartable`) and explains in place of starting. Same question, same
 * function, so the two cannot come to disagree about what "can run" means.
 *
 * DATA DECIDES, NOT THE MOUNT SITE, so the two places the checklist is mounted
 * need no rules of their own:
 *
 * - `account` opens on `[data-tour="account-new"]` — the Accounts page's "New
 *   Account" — which `AccountList` renders for every user, with accounts or
 *   without. There is no state this set cannot start from, which is the point of
 *   moving it there: it used to open on the dashboard's welcome screen, a screen
 *   that is gone for good once any account exists, so the one walkthrough about
 *   creating an account could not be replayed by anyone who had created one.
 * - `position` opens on `[data-tour="position-new"]`, which `PositionList` tags
 *   only on its enabled branch — the one it takes once an account exists. It
 *   needs an account the user OWNS, for the reason below.
 * - `close` opens on `/positions/$positionId`, and the only id anyone has for
 *   that route is the open position `useWalkthrough` falls back to — which is
 *   one of the user's own, for the same reason. No open position of theirs, no
 *   route to navigate to.
 * - `calculator` has nothing that can be missing either: `/calculator` renders
 *   its fields for every user, which is why it is the one item a user with no
 *   accounts can complete.
 *
 * "RUNS" MEANS "GETS THE USER SOMEWHERE", SO SAMPLE DATA DOES NOT COUNT FOR THE
 * TWO SETS THAT END IN A ROW BEING WRITTEN. The checklist excludes the sample
 * account and everything booked against it from completion — deliberately, so
 * clicking "Add sample data" cannot tick items for trades the user never made —
 * and these answers have to mean the same thing by "the user's data" or they
 * hand out buttons that lead nowhere. A user with sample data and nothing else
 * pressing `position` would be walked through logging a position against the
 * demo account, and `close` through closing one of the fixture's rows: guidance
 * followed to the end, and the item still unticked afterwards with nothing on
 * screen to say why. That is worse than the button being absent, so both are
 * withheld until the user has a real account (`position`) and a real open
 * position (`close`). The sample state is the one the user leaves by removing
 * the sample data or creating an account — either takes the demo rows away and
 * both buttons come back with something behind them.
 *
 * THE SAMPLE ACCOUNT IS THE ONE STATE `account` IS WITHHELD IN, and the reason
 * is the product's, not the tour's: sample data and real accounts cannot both
 * exist, so "New Account" puts up a confirmation to remove the sample data
 * instead of opening the form, and the server refuses the create outright until
 * it is gone (`AccountList.beginCreate`, `useCreateAccount`'s
 * `DEMO_ACCOUNT_EXISTS` branch). A tour cannot drive that confirmation: it sits
 * under the walkthrough's own overlay, and the click that reaches for it lands
 * on the overlay and ends the walkthrough where it stands — verified in a
 * browser, and silent, which is the failure this whole branch exists to stop.
 * So the set is refused in words, exactly as `position` is for the same user,
 * and both come back the moment the sample data is removed.
 *
 * An unknown count (the read is disabled, in flight, or failed) answers "no" for
 * every set that depends on it. Withholding a shortcut that would have worked
 * costs the user a click on the item's own screen; offering one that cannot
 * costs them a walkthrough that silently never starts.
 */
interface StartableFrom {
  /** Accounts the user created themselves, on the checklist's terms. */
  ownAccountCount: number | undefined;
  /** The sample account exists — `useDemoAccount`'s own rule. */
  hasDemoAccount: boolean;
  /** One of the user's own positions is open — not one of the fixture's. */
  hasOwnOpenPosition: boolean;
}

function canStartSet(itemId: ChecklistItemId, from: StartableFrom): boolean {
  switch (itemId) {
    case 'account':
      return !from.hasDemoAccount;
    // Nothing on /calculator can be missing, for anyone.
    case 'calculator':
      return true;
    case 'position':
      return from.ownAccountCount !== undefined && from.ownAccountCount > 0;
    case 'close':
      return from.hasOwnOpenPosition;
  }
}

/**
 * Whether starting this set needs the user's rows read at all.
 *
 * The launcher has no mounted reads, so the only way it can answer `canStartSet`
 * is to ask the server at the click — a request worth making for a question that
 * has an answer, and worth NOT making for one that does not. `calculator` is
 * that second case: it starts from anywhere, for anyone, and needs no route
 * values, so a read before it could only ever come back "yes, as always".
 *
 * A switch rather than a set literal, and exhaustive, so it cannot fall out of
 * step with `canStartSet` above: a fifth set is a type error in both or neither.
 */
function needsStartableRead(itemId: ChecklistItemId): boolean {
  switch (itemId) {
    case 'account':
    case 'position':
    case 'close':
      return true;
    case 'calculator':
      return false;
  }
}

/** What a set needs to run, and the values the one that opens on a position needs. */
interface Startable {
  from: StartableFrom;
  /** The position the close set opens on, or `undefined` when there is none. */
  openPositionParams: Record<string, string> | undefined;
}

/**
 * THE SAME TWO ANSWERS `useWalkthrough` DERIVES FROM ITS MOUNTED READS, ASKED
 * FROM A CLICK INSTEAD OF FROM A RENDER.
 *
 * The checklist can subscribe to the accounts and positions lists because it is
 * only ever mounted for a user whose read gate is open. The permanent entry
 * point cannot: mounting those reads on a settings screen would put the two
 * expensive queries back for every user, which is the property the gate exists
 * to protect. So it asks the same questions of the same cache entries at the
 * moment the user presses Start — a request the user asked for, not a passive
 * read on the way past — and nothing at all before then.
 *
 * `fetchQuery` AND NOT `ensureQueryData`, AND THE DIFFERENCE IS THE WHOLE ANSWER
 * BEING RIGHT. `ensureQueryData` hands back whatever is in the cache whenever
 * something is, however old and however explicitly invalidated; it only fetches
 * when the entry is missing outright. Nothing keeps this entry fresh, either:
 * `['positions', 'list', undefined]` is subscribed to by the checklist and by
 * `useWalkthrough`, both of which are switched off for exactly the retired user
 * this door exists for, so the invalidation every create and close publishes
 * marks it stale and no observer ever refetches it. The refusal below is
 * therefore decided on a snapshot of the user's data from the last time they
 * pressed one of these buttons.
 *
 * That made this notice's own remedy fail. It tells a user with no open position
 * to go and log one — and a user who did exactly that, came back, and pressed
 * Start was refused a second time in the same words, with no request sent. Only
 * a full page reload, which drops the cache, made the button work. It goes wrong
 * the other way too: close a position and the stale entry still calls it open,
 * so the set starts and points at an exit control that is gone. A remedy that
 * does not work is worse than no remedy, so the read that decides has to be a
 * read of now.
 *
 * WHAT THAT COSTS IS ONE REQUEST PER PRESS, and it is the right price. The app's
 * client keeps the library's `staleTime` of zero (`lib/queryClient.ts`), so this
 * genuinely goes to the server each time — but only for the two sets whose
 * answer depends on it (`needsStartableRead`), only when a user has pressed a
 * button asking to be walked through something, and never on the way past. The
 * alternative on offer was a free answer that was wrong.
 *
 * A FAILED READ IS "DON'T KNOW", NOT "NO", and the two must not be collapsed.
 * The checklist withholds a shortcut it cannot substantiate because it can put
 * the user on the item's own screen instead; there is no such screen here, and
 * telling someone their trades are missing because a request failed would be a
 * sentence about the wrong thing. `null` means the caller should go ahead and
 * let the walkthrough report its own ending, which is what it did before this
 * gate existed.
 */
async function resolveStartable(queryClient: QueryClient): Promise<Startable | null> {
  try {
    const [accounts, positions] = await Promise.all([
      queryClient.fetchQuery(accountsListQuery()),
      queryClient.fetchQuery(positionsListQuery()),
    ]);
    // The checklist's own selector, for the reason given where it is defined:
    // "the user's data" has to mean here exactly what it means to completion.
    const { ownAccounts, ownPositions } = selectOwnRows(accounts, positions);
    const open = ownPositions.find((position) => position.status === 'open');
    return {
      from: {
        ownAccountCount: ownAccounts.length,
        hasDemoAccount: accounts.length > ownAccounts.length,
        hasOwnOpenPosition: open !== undefined,
      },
      openPositionParams: open ? { positionId: open.id } : undefined,
    };
  } catch {
    return null;
  }
}

/** The first item the user has not done — the set to run, and the resume point. */
export function nextIncompleteItem(
  checklist: Checklist | null | undefined,
): ChecklistItemId | null {
  return checklist?.items.find((item) => !item.done)?.id ?? null;
}

type NavigateFn = (opts: { to: string; params?: Record<string, string> }) => unknown;

/**
 * Put the user on the screen a step lives on, before the tour reaches it, so
 * that step's `waitForMs` covers the route mounting rather than a navigation
 * that has not been asked for yet.
 *
 * A parameterised route (`/positions/$positionId`) needs values only the caller
 * has — the id of the position the user just created — so it navigates only when
 * they were supplied. Without them we start where the user already is, which is
 * right when they got here from that very position's page and degrades to a
 * clean `target-missing` exit when they did not.
 */
function navigateToStep(
  step: WalkthroughStep,
  params: Record<string, string> | undefined,
  navigate: NavigateFn,
): void {
  const needed = step.routeParams ?? [];
  if (needed.some((name) => params?.[name] === undefined)) return;
  navigate(needed.length > 0 ? { to: step.route, params } : { to: step.route });
}

/**
 * The same, for a move BETWEEN two steps: navigate only when the set actually
 * changes screen.
 *
 * Most transitions do not. A set that stays on one route must not re-navigate to
 * it on every step — that would remount the screen under a dialog the previous
 * step just opened.
 *
 * The two that do are both changes of screen the WALKTHROUGH has to make,
 * because the app makes neither: creating a position leaves the user on
 * `/positions`, and closing one leaves them on the position. So this is the only
 * thing carrying the position set onto `/positions/$positionId` and the close
 * set onto `/dashboard`. It still declines a parameterised route it has no
 * values for — `navigateToStep` sees to that — which is why `bindAdvance` folds
 * the new position's id into the session's params before calling here.
 */
function navigateBetweenSteps(
  from: WalkthroughStep,
  to: WalkthroughStep | undefined,
  params: Record<string, string> | undefined,
  navigate: NavigateFn,
): void {
  if (to === undefined || to.route === from.route) return;
  navigateToStep(to, params, navigate);
}

/**
 * Fill in the values a set's OPENING route needs and the caller did not give.
 *
 * Only the opening one, and that boundary is the point. A set that opens on
 * `/positions/$positionId` has nowhere else to start, so a fallback is the
 * difference between running and exiting `target-missing` on the first step. A
 * set that merely REACHES a parameterised route later — the position set, which
 * starts on `/positions` and follows the user to whatever position they just
 * created — must be left alone: handing it an id derived from the user's other
 * data would navigate them away from their new position onto an older one. That
 * set gets its id from the event that reports the create instead, which is the
 * only source that names the right row.
 */
function withOpeningParams(
  first: WalkthroughStep,
  params: Record<string, string> | undefined,
  fallback: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const needed = first.routeParams ?? [];
  if (needed.length === 0) return params;
  if (needed.every((name) => params?.[name] !== undefined)) return params;
  return { ...fallback, ...params };
}

/**
 * One toast, reused. A user who stops twice gets the second explanation in
 * place of the first rather than a stack of them.
 */
const STOP_NOTICE_ID = 'walkthrough-stopped';

/**
 * Long enough to read twice. The notice arrives at the moment an overlay the
 * user was reading disappeared, so it has to survive the double-take that
 * causes; it is still transient, so it carries no close button — the app's one
 * permanent notice is the only one that needs a manual way out.
 */
const STOP_NOTICE_MS = 12_000;

/**
 * WHY THE TOUR STOPPED, IN WORDS, ON SCREEN.
 *
 * A walkthrough that ends without saying why is this area's recurring defect
 * rather than an oversight in one step: it has now happened from three separate
 * causes — a set left on the wrong route, a highlighted control that unmounted
 * mid-tour, and a user declining the action a step waits for — and each time it
 * looked identical from the user's seat, which is to say it looked like nothing
 * at all. So the answer is one path for "the tour could not carry on", not a
 * message bolted onto whichever cause was reported last.
 *
 * WHAT IT DOES NOT COVER, DELIBERATELY. Completion needs no explanation, a
 * session that ended took the whole screen with it, and an ordinary dismissal
 * is the user saying they are done — telling someone who closed the tour that
 * the tour closed is nagging. The trigger is the engine's `TourBlock`: a step
 * the user could not get past, and which of the two things held them there.
 *
 * ACTION-GATED STEPS GET THE HONEST REASON. Replaying a set still requires the
 * real thing — creating the position, recording the exit fill — because that is
 * what the walkthrough teaches, so a user who does not want to place another
 * trade genuinely cannot go on. What was missing was never the gate; it was
 * anyone saying so.
 *
 * THE CLASSIFICATION IS THE ONLY INPUT, AND THAT IS THE FIX. This wording has
 * twice been chosen from something standing next to the cause instead of the
 * cause itself — first the step's own `advanceOnAction` flag, then the exit
 * reason — and each time it told a user whose control had never rendered, or had
 * gone, that they had declined to press it. Both readings were available because
 * both were being reassembled here out of parts. They are not any more: the
 * engine decides, from the live DOM at the moment it gives up, and this is a
 * switch over that decision. The switch is exhaustive with no default, so a
 * third cause is a type error here rather than a sentence about the wrong thing.
 */
function explainStop(blocked: TourBlock): string {
  switch (blocked.cause) {
    case 'action-required':
      // The control was on screen and pressable and the user left anyway, which
      // is the one stop that is theirs to clear.
      return `“${blocked.step.title}” only moves on once you have actually done it, so the walkthrough cannot take that step for you.`;
    case 'target-missing':
      // Present tense, because it is true of both ways a control comes to be
      // absent: one that never rendered, and one the user has since dismissed
      // along with the dialog it lived in.
      return `“${blocked.step.title}” is not on screen, so the walkthrough could not carry on from there.`;
  }
}

/**
 * WHERE TO START IT AGAIN — one answer, true for every reader.
 *
 * It used to name the setup checklist, which is the one surface that can have
 * gone: the checklist RETIRES for good once all four items are complete, and a
 * user who finished onboarding is precisely the user this notice was sending
 * back to it. Settings › Help is the walkthrough's permanent home — it is there
 * for every user, retired or not — so it is the direction that cannot come to be
 * false under the person reading it.
 */
const START_AGAIN_HERE = 'start it again whenever you want from Settings → Help';

function announceStop(blocked: TourBlock | undefined): void {
  if (blocked === undefined) return;

  toast.info('The walkthrough stopped', {
    id: STOP_NOTICE_ID,
    duration: STOP_NOTICE_MS,
    // Both ways out, named: nothing was riding on the tour, and the door it was
    // started from is still there. Exiting discards nothing — this module writes
    // no onboarding state at all — so "nothing was lost" is a structural fact
    // rather than a reassurance.
    description: `${explainStop(blocked)} Nothing was lost — carry on without it, or ${START_AGAIN_HERE}.`,
  });
}

/**
 * WHY A SET CANNOT BEGIN AT ALL, SAID AT THE CLICK RATHER THAN FIVE SECONDS
 * LATER.
 *
 * This is a different thing from `explainStop`, and the difference is the one
 * the launcher was shipped blurring: a tour that stops was running and could not
 * carry on, while none of these three could have got anywhere. Two have nothing
 * to open on — a position the user does not have, an account they have not made
 * — and starting them would put an overlay over nothing until the first step's
 * `waitForMs` expired, which is a button that appears to do nothing. The third,
 * `account`, opens fine and then cannot proceed: the form behind "New Account"
 * only opens once the sample data has been removed, and that confirmation is not
 * something a tour can drive.
 *
 * So each answer names what is in the way AND what to do about it. The set is
 * still offered afterwards: the user who logs a position can press `close` five
 * minutes later and it will run — and now genuinely does, because the read
 * behind that decision is taken fresh at the click (`resolveStartable`). Both
 * remedies were followed in a browser, from the refusal to the set running.
 */
function explainCannotStart(itemId: ChecklistItemId): string {
  switch (itemId) {
    case 'account':
      return (
        'Your own accounts and the sample account cannot both exist, so creating one starts by ' +
        'removing the sample data — and that is a confirmation this walkthrough cannot take you ' +
        'through. Remove the sample data first, from the banner on your dashboard, and this ' +
        'walkthrough will run.'
      );
    case 'position':
      return (
        'A position is booked against an account, and you have none of your own yet — the sample ' +
        'data does not count, because a position logged against it would tick nothing. Create an ' +
        'account under Accounts and this walkthrough will run.'
      );
    case 'close':
      return (
        'This one runs on a position of yours that is still open, and you have none right now. ' +
        'Log one and open it, then start this walkthrough again.'
      );
    case 'calculator':
      // Unreachable: `canStartSet` answers yes for this set unconditionally,
      // because /calculator renders its fields for every user, and
      // `needsStartableRead` means the launcher does not even ask before
      // starting it. Kept so the switch stays exhaustive and a fifth set is a
      // type error here.
      return 'This walkthrough cannot start from where you are right now.';
  }
}

function announceCannotStart(itemId: ChecklistItemId): void {
  toast.info('That walkthrough cannot start yet', {
    // The walkthrough's one notice, reused: a user who presses two sets in a row
    // gets the second explanation in place of the first rather than a stack.
    id: STOP_NOTICE_ID,
    duration: STOP_NOTICE_MS,
    // No "start it again from …" here, unlike `announceStop`: this notice can
    // only be raised by the launcher, so the reader is already looking at the
    // place they would be sent to. The set stays on the card either way.
    description: `${explainCannotStart(itemId)} Nothing was changed.`,
  });
}

async function run(
  itemId: ChecklistItemId,
  callerParams: Record<string, string> | undefined,
  navigate: NavigateFn,
  fallbackParams?: Record<string, string>,
): Promise<void> {
  const runtime = await loadRuntime();
  if (!runtime) return;
  const [engine, steps] = runtime;

  const set = steps.WALKTHROUGH_STEPS[itemId];
  if (!set || set.length === 0) return;

  const params = withOpeningParams(set[0], callerParams, fallbackParams);

  // Any session already running ends HERE, before anything new is set up.
  // `startTour` ends the previous tour itself, but it does so from inside the
  // new start — and the old session's `onExit` would then run `endSession()`
  // over the session we had just built, unsubscribing it. Ending first means
  // that teardown lands on the old session, which is whose it is.
  engine.stop();
  endSession();

  activeSteps = withObservableActionsOnly(set);
  // After `endSession()`, which clears them: these belong to the session being
  // built, not to the one just torn down.
  activeParams = params;
  bindAdvance(engine, navigate);
  navigateToStep(activeSteps[0], activeParams, navigate);

  useWalkthroughStore.setState({
    isRunning: true,
    isUnavailable: false,
    itemId,
    currentStep: null,
    stepIndex: -1,
  });

  // Emitted here rather than from `start()`: this is the first line at which a
  // tour genuinely begins. A runtime that would not load, or a set with no
  // steps, has already returned above, so "started" never counts a walkthrough
  // the user did not get.
  emitOnboardingEvent({
    name: 'onboarding_walkthrough_started',
    item: itemId,
    stepCount: activeSteps.length,
  });

  engine.startTour(activeSteps, {
    // The same navigation `bindAdvance` does, for the moves it does not make:
    // the ones the user makes themselves with "Next" or the right arrow. A set
    // changes screen only across an action-gated step, so this used to be
    // unreachable — until a gated step whose control is disabled began handing
    // "Next" back (tour-engine.ts, `isGatedStep`), which is exactly the move
    // that carries the close set from the position onto the dashboard when the
    // user exited only part of their position.
    //
    // Reads `activeParams` rather than closing over the value it had at
    // `start()`, for the same reason `bindAdvance` writes to it: the id of the
    // position a set moves onto is only known once the user has made it.
    onBeforeAdvance: (index) => {
      navigateBetweenSteps(activeSteps[index], activeSteps[index + 1], activeParams, navigate);
    },
    onStepChange: (index) => {
      useWalkthroughStore.setState({ stepIndex: index, currentStep: activeSteps[index] ?? null });
    },
    // Every ending arrives here — completed, dismissed, or a target that never
    // appeared — and all three do the same thing to the user's data, because
    // none of them has any work to undo. They are told apart for the funnel,
    // and for whether the user is owed an explanation (`announceStop`).
    onExit: (reason, blocked) => {
      // THE STEP INDEX COMES FROM THE LIVE SESSION, AND IS READ BEFORE THE
      // TEARDOWN THAT CLEARS IT. Nothing stores a step index — resume
      // re-derives its position from the checklist instead, and adding a stored
      // one for the sake of an event would be a second source of truth that
      // could disagree with the first. The running session already tracks
      // where the tour is, because the overlay has to be somewhere; the
      // abandonment event is just that number, taken on the way out. It is `-1`
      // when no step was ever highlighted.
      const { stepIndex } = useWalkthroughStore.getState();
      const stepCount = activeSteps.length;
      endSession();

      if (reason === 'completed') {
        emitOnboardingEvent({ name: 'onboarding_walkthrough_completed', item: itemId, stepCount });
        return;
      }
      emitOnboardingEvent({
        name: 'onboarding_walkthrough_abandoned',
        item: itemId,
        stepIndex,
        stepCount,
        reason,
      });
      // After the teardown, so the screen the user is left with is the one the
      // notice is about.
      announceStop(blocked);
    },
  });
}

export interface UseWalkthroughResult {
  /**
   * Start a walkthrough. With no argument it runs the set for the first
   * incomplete checklist item, which is both "start me at the beginning" and
   * "resume where I was" — the two are the same question asked of the same
   * data. `params` supplies the values a parameterised route needs; omitted, a
   * set that opens on a position falls back to the most recently touched open
   * one.
   *
   * Never throws, and never rejects: a runtime that will not load leaves
   * `isUnavailable` true and everything else exactly as it was.
   */
  start: (itemId?: ChecklistItemId, params?: Record<string, string>) => void;
  /**
   * Whether that item's set would actually run from the user's data as it
   * stands — see `canStartSet`. A caller offering a per-item shortcut asks this
   * first, so it never puts up a button behind which the tour would exit
   * `target-missing` in silence. It is about the SET, not about the item's
   * completion: a completed item whose set still runs is still startable, which
   * is what makes the walkthrough repeatable.
   */
  canStart: (itemId: ChecklistItemId) => boolean;
  /** End the running walkthrough. A no-op when none is running. */
  stop: () => void;
  isRunning: boolean;
  /** The tour runtime failed to load; offer the unguided path instead. */
  isUnavailable: boolean;
  /** Which set is running, or `null`. */
  itemId: ChecklistItemId | null;
  currentStep: WalkthroughStep | null;
  /** Zero-based index into the running set; `-1` between steps and when idle. */
  stepIndex: number;
}

/**
 * Just the suppression signal: is a walkthrough on screen right now?
 *
 * A separate hook rather than `useWalkthrough().isRunning` because the full
 * hook composes `useOnboarding()` — which pulls the entire unfiltered positions
 * list down to count it — and the coach marks that ask this question sit on
 * ordinary working surfaces that have no use for a checklist. Reading one
 * boolean should not cost a request.
 *
 * Synchronous, from the module-scoped store, so a consumer can decide not to
 * render AT ALL on the same tick. A mark that mounts and then withdraws in an
 * effect still paints a frame over the highlight the tour is pointing at.
 */
export function useIsWalkthroughRunning(): boolean {
  return useWalkthroughStore((state) => state.isRunning);
}

export interface UseWalkthroughLauncherResult {
  /** Run one named set. The id is required — nothing here knows what is outstanding. */
  start: (itemId: ChecklistItemId, params?: Record<string, string>) => void;
  /** The tour runtime failed to load; there is nothing behind the controls. */
  isUnavailable: boolean;
}

/**
 * START A NAMED SET, AND READ NOTHING UNTIL THE USER ASKS.
 *
 * `useWalkthrough` composes `useOnboarding` because it answers questions about
 * the user's progress — which set is outstanding, which sets could run from the
 * data as it stands. A permanent entry point asks neither on the way past: it
 * offers all four sets to everyone, always, so the user's checklist is not an
 * input to what it puts on screen.
 *
 * THAT IS THE WHOLE POINT OF THIS HOOK EXISTING. The checklist RETIRES when the
 * four items are complete, and the retirement write is what switches
 * `useOnboarding`'s two expensive reads — the accounts list and the whole
 * unfiltered positions list — off for good. An entry point that has to outlive
 * retirement therefore cannot be built on a hook that reads onboarding state:
 * mounting one on an ordinary settings screen would put those reads back for
 * every `pending`/`active` user, and asking a retired user's checklist which
 * sets to offer would answer "none", which is the defect it was added to fix.
 * So mounting this costs no request at all, and the onboarding preference — the
 * value the gate is keyed on — is never read from here at any point, click
 * included.
 *
 * It also WRITES nothing, and that matters more here than at the other doors.
 * The zero-state and the checklist slot write `status: 'active'` as the opt-in
 * record before starting a tour; doing the same from settings would un-retire a
 * user who had finished — turning both gated reads back on and putting the
 * checklist back on their dashboard — for no reason other than that they asked
 * to see a walkthrough again.
 *
 * `run()` is the same launcher the checklist's per-item buttons go through, so
 * a set started from here is the set they start, step for step — INCLUDING the
 * position the close set opens on. That fallback is derived from the user's own
 * rows, and this hook resolves them from the CLICK rather than from a render
 * (`resolveStartable`): reading nothing on mount is the constraint, and it says
 * nothing about a request the user asked for. Without it that button was a tour
 * that navigated nowhere, waited out its first step and vanished — the exact
 * "reachable and useless" failure the checklist path fixed for itself.
 *
 * THREE OF THE FOUR ASK THAT QUESTION, AND ONLY THOSE THREE. `position` and
 * `close` open on something the user may not have, and `account` cannot get past
 * its own first step while sample data is what a new account would replace.
 * `calculator` opens on fields `/calculator` renders for everybody and needs no
 * route values, so it is started without a request at all
 * (`needsStartableRead`).
 *
 * AND A SET THAT STILL CANNOT RUN SAYS SO IMMEDIATELY, in place of starting.
 * `canStartSet` is the same question the checklist asks before offering a
 * shortcut; the difference is only when it can be asked. The checklist has the
 * answer at render and withholds the button; this card cannot know until the
 * click, so it answers then — which is a control that responds rather than one
 * that appears to do nothing for five seconds and then apologises. What it
 * answers from is the data as it is at that click, not as it was at the last
 * one: see `resolveStartable`, where getting that wrong made the refusal's own
 * advice impossible to act on.
 */
export function useWalkthroughLauncher(): UseWalkthroughLauncherResult {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isUnavailable = useWalkthroughStore((state) => state.isUnavailable);

  const start = useCallback(
    (itemId: ChecklistItemId, params?: Record<string, string>) => {
      void (async () => {
        // A set that starts from anywhere and needs no route values is started,
        // not investigated: the read below could only come back "yes, as
        // always", and a request nobody's answer depends on is one this card
        // should not make.
        if (!needsStartableRead(itemId)) {
          await run(itemId, params, navigate as NavigateFn);
          return;
        }
        const startable = await resolveStartable(queryClient);
        if (startable && !canStartSet(itemId, startable.from)) {
          announceCannotStart(itemId);
          return;
        }
        await run(itemId, params, navigate as NavigateFn, startable?.openPositionParams);
      })();
    },
    [navigate, queryClient],
  );

  return { start, isUnavailable };
}

export function useWalkthrough(): UseWalkthroughResult {
  const navigate = useNavigate();
  const { checklist } = useOnboarding();
  const state = useWalkthroughStore();

  // THE SET THAT OPENS ON A POSITION NEEDS ONE, AND NO CALLER HAS IT. The
  // checklist knows which ITEM is outstanding — "close it and see the stats" —
  // and never which row that is about, so a caller pressing its "Start" can only
  // name the set. Without a `positionId` the close set opens wherever the user
  // happens to be, finds none of its targets and exits `target-missing`: the
  // guided path for item 4 was reachable and useless.
  //
  // The position they mean is the one they last touched and have not closed.
  // `GET /positions` comes back ordered by `updatedAt` descending, so that is
  // the first open row in the list the checklist was already derived from — the
  // same cache entry, so this observer costs no extra request. An explicit
  // `params` from the caller always wins; this is only the fallback.
  const { data: positions } = usePositions(undefined, { enabled: checklist != null });

  // The accounts list, the whole thing with the demo row still in it — which is
  // what makes it possible to tell the sample account's positions from the
  // user's below. Same query key as the dashboard zero-state gate's own read and
  // as `useOnboarding`'s, and gated on the same condition as the positions
  // observer, so this costs no extra request on either screen the checklist is
  // mounted on.
  const { data: accounts } = useAccounts({ enabled: checklist != null });

  // THE USER'S OWN ROWS, FROM THE CHECKLIST'S OWN SELECTOR. `canStartSet` has to
  // mean by "the user's data" exactly what completion means by it, and reusing
  // `selectOwnRows` is what makes that true by construction rather than by two
  // filters happening to agree. `undefined` until BOTH reads have landed: which
  // positions belong to the sample account is not knowable from the positions
  // list alone, and a half-answer here would offer buttons for one render.
  const own = useMemo(
    () => (accounts && positions ? selectOwnRows(accounts, positions) : undefined),
    [accounts, positions],
  );

  // The fallback comes from the same filtered list, so the close set can never
  // open on one of the fixture's positions: closing that would teach the user
  // the right gesture and tick nothing.
  const openPositionParams = useMemo(() => {
    const open = own?.ownPositions.find((position) => position.status === 'open');
    return open ? { positionId: open.id } : undefined;
  }, [own]);

  const hasOwnOpenPosition = openPositionParams !== undefined;
  const ownAccountCount = own?.ownAccounts.length;
  // The same rule `useDemoAccount` uses, from the list already read here rather
  // than from a second read of it.
  const hasDemoAccount = accounts?.some((account) => account.isDemo) ?? false;
  const canStart = useCallback(
    (itemId: ChecklistItemId) =>
      canStartSet(itemId, { ownAccountCount, hasDemoAccount, hasOwnOpenPosition }),
    [ownAccountCount, hasDemoAccount, hasOwnOpenPosition],
  );

  // What the funnel counts as "offered": there is a walkthrough behind the
  // button and the user could press it. Mounting this hook IS the offer — the
  // two things that mount it, `ZeroState` and the dashboard's checklist slot,
  // do so precisely to put "Walk me through it" and the checklist's per-item
  // "Start" on screen — so the condition here is the same one `ZeroState`
  // disables its control on: a runtime that will load, and a checklist naming
  // an outstanding item.
  //
  // This does not weaken opt-in-only. Nothing below starts anything; it counts
  // an opportunity that was on screen either way, and the tour still only ever
  // begins from a click.
  //
  // The ref makes it the OFFER that is counted rather than the render. Emitting
  // on every render would report a few dozen offers per screen, and emitting
  // once per mount would miss the genuinely new offer a user is given when they
  // finish one item and the next becomes outstanding under them.
  const offeredItem = state.isUnavailable ? null : nextIncompleteItem(checklist);
  const lastOffered = useRef<ChecklistItemId | null>(null);
  useEffect(() => {
    if (offeredItem === null || offeredItem === lastOffered.current) return;
    lastOffered.current = offeredItem;
    emitOnboardingEvent({ name: 'onboarding_walkthrough_offered', item: offeredItem });
  }, [offeredItem]);

  const start = useCallback(
    (itemId?: ChecklistItemId, params?: Record<string, string>) => {
      const target = itemId ?? nextIncompleteItem(checklist);
      // Nothing to guide: the checklist has not loaded, this user has none, or
      // every item is already done. Silence is right — there is no failure here
      // to report.
      if (!target) return;
      void run(target, params, navigate as NavigateFn, openPositionParams);
    },
    [checklist, navigate, openPositionParams],
  );

  const stop = useCallback(() => {
    // The engine is only reachable once it has loaded, and it can only be
    // running if it has. `endSession()` covers the case where it never did.
    if (!enginePromise) {
      endSession();
      return;
    }
    void enginePromise.then(([engine]) => engine.stop()).catch(() => endSession());
  }, []);

  return {
    start,
    canStart,
    stop,
    isRunning: state.isRunning,
    isUnavailable: state.isUnavailable,
    itemId: state.itemId,
    currentStep: state.currentStep,
    stepIndex: state.stepIndex,
  };
}

/** Test seam: drop the module-scoped session and the cached runtime import. */
export function __resetWalkthroughForTests(): void {
  endSession();
  enginePromise = null;
  useWalkthroughStore.setState({ ...IDLE, isUnavailable: false });
  // Restore the module's import-time state in full: a test that clears the
  // event bus has taken the logout listener with it.
  armLogoutTeardown();
}

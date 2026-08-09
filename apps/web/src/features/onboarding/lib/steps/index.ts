/**
 * The walkthrough's step content, as data.
 *
 * FOUR SETS, ONE PER CHECKLIST ITEM. `account`, `calculator`, `position` and
 * `close` are the same four ids `derive-checklist.ts` uses, so the checklist and
 * the walkthrough cannot drift apart on what the four steps ARE.
 *
 * DATA ONLY. No React, no `driver.js`, no DOM: `TourStep` is imported as a TYPE
 * from `../tour-engine`, which erases at compile time, so nothing here pulls the
 * tour runtime — or its CSS — into a chunk. The test for this module runs under
 * the node environment to keep that honest.
 *
 * ACCURACY AGAINST THE SHIPPED UI IS THE BAR THIS FILE IS WRITTEN TO. Every
 * field name, default, bound and behaviour below was read out of the shipped
 * source before it was written down, and the copy uses the words the UI itself
 * uses ("Trading-day timezone", "Default risk %", "Risk percent", "Open
 * Position") rather than paraphrases. No step may describe a field, default or
 * behaviour that does not exist: the walkthrough is the first thing a new user
 * believes about the product, so a claim that is not true of the screen in front
 * of them is worse than no walkthrough at all. The account's default risk % and
 * the stored reporting timezone were built before this copy was written, for
 * exactly that reason. A claim that cannot be substantiated against `apps/web`,
 * `apps/api` or `packages/shared` does not go in.
 *
 * WHY `body` AND `docs` RATHER THAN A HAND-WRITTEN `description`. Each step owes
 * a "read more" deep link and the host must appear exactly once, in
 * `lib/docs.ts`. Authors write prose and name a page; `compile()` below is the
 * only place an anchor is built, so no step file can hardcode a documentation
 * host and no step can forget the link.
 */

import { docsUrl, type DocsPage } from '@/lib/docs';

import type { ChecklistItemId } from '../derive-checklist';
import type { TourStep } from '../tour-engine';

import { accountSteps } from './account';
import { calculatorSteps } from './calculator';
import { closeSteps } from './close';
import { positionSteps } from './position';

/**
 * A step as AUTHORED. `description` is absent on purpose — it is composed from
 * `body` and `docs` by `compile()`.
 */
export interface WalkthroughStepSource extends Omit<TourStep, 'description'> {
  /**
   * The prompt itself. Rendered as HTML by the engine, so `&` must be written
   * `&amp;`. Author-written repo source only — NEVER interpolate user input.
   */
  body: string;
  /** The documentation page this step's "read more" link opens. */
  docs: DocsPage;
  /**
   * The in-app route the step's target lives on. Not consumed by the engine —
   * it is what lets the test prove no step anchors to a screen that does not
   * exist, and what `useWalkthrough` navigates to when resuming.
   *
   * This is the ROUTER'S PATTERN, not a URL: a parameterised route is written
   * `/positions/$positionId`, which no one can navigate to as it stands.
   * `routeParams` is what makes it navigable.
   */
  route: string;
  /**
   * The `$` segments of `route`, in the order they appear — the contract for
   * `navigate({ to: step.route, params })`. Omitted when `route` has none, which
   * is the case that IS navigable as written.
   *
   * Only the NAMES can be authored: the values are runtime state (the id of the
   * position the user just made), and resuming re-derives the set from the
   * user's data rather than storing a step, so `useWalkthrough` holds them, not
   * this file. The test keeps the names in step with the pattern.
   */
  routeParams?: readonly string[];
}

/** A compiled step: a `TourStep` the engine can drive, plus its provenance. */
export type WalkthroughStep = TourStep &
  Pick<WalkthroughStepSource, 'docs' | 'route' | 'routeParams'>;

/**
 * The one place a documentation link is built. External host, so it opens in a
 * new tab for the same reason every other docs link in the app does — the
 * reader is mid-task and replacing the app loses their place.
 */
export function readMore(page: DocsPage): string {
  return `<a href="${docsUrl(page)}" target="_blank" rel="noreferrer">Read more</a>`;
}

function compile(sources: readonly WalkthroughStepSource[]): WalkthroughStep[] {
  return sources.map(({ body, docs, route, ...step }) => ({
    ...step,
    docs,
    route,
    description: `${body} ${readMore(docs)}`,
  }));
}

/**
 * The four step sets, keyed by the checklist item each one completes. Assignable
 * to `TourStep[]` as-is, so `startTour(WALKTHROUGH_STEPS.account)` is the whole
 * integration.
 */
export const WALKTHROUGH_STEPS: Record<ChecklistItemId, WalkthroughStep[]> = {
  account: compile(accountSteps),
  calculator: compile(calculatorSteps),
  position: compile(positionSteps),
  close: compile(closeSteps),
};

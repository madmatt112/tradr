// @vitest-environment node
//
// node, NOT jsdom: the step sets are data, so proving them correct must not need
// a browser. If a change makes this file need jsdom, the step modules have
// stopped being data (design.md, "Modular Design Principles").
//
// WHAT THIS FILE IS FOR. R6.11 says no step may describe a field, default or
// behaviour that does not exist. Prose cannot be checked mechanically, but its
// two mechanical halves can, and they are the two ways the copy rots without
// anyone noticing: a step anchored to a selector nobody renders any more, and a
// "read more" link to a page nobody wrote. Both are checked against the source
// tree here rather than against a list maintained alongside it, so a rename in
// `AccountDialog`, a deleted route or a moved docs page fails this test.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOCS, DOCS_BASE_URL, docsUrl, type DocsPage } from '@/lib/docs';

import { WALKTHROUGH_STEPS, type WalkthroughStep } from './index';

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const WEB_SRC = path.join(REPO_ROOT, 'apps/web/src');
const DOCS_CONTENT = path.join(REPO_ROOT, 'apps/docs/src/content/docs');
const ROUTE_TREE = path.join(WEB_SRC, 'routeTree.gen.ts');

const SET_IDS = ['account', 'calculator', 'position', 'close'] as const;

function walk(dir: string, match: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full, match);
    return match(full) ? [full] : [];
  });
}

/**
 * Every non-test COMPONENT file in the web app, concatenated. Targets are
 * checked by containment against this rather than by rendering, because a step's
 * target has to survive in the source whether or not any test happens to mount
 * the component that carries it.
 *
 * `.tsx` only, and that is load-bearing rather than an optimisation: the step
 * modules are `.ts` and quote their own selectors, so scanning them too would
 * let every step vouch for itself and the check would pass for a target nothing
 * renders. Verified by pointing a step at a selector that exists nowhere and
 * watching this fail.
 */
const webSource = walk(WEB_SRC, (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/**
 * The router's own generated full paths — the definition of "a route exists".
 * An index route is generated with a trailing slash (`/positions/`) but linked
 * to without one, so both spellings count.
 */
const routes = new Set(
  Array.from(
    readFileSync(ROUTE_TREE, 'utf8').matchAll(/fullPath: '([^']+)'/g),
    (m) => m[1],
  ).flatMap((full) => (full.length > 1 ? [full, full.replace(/\/$/, '')] : [full])),
);

const allSteps: [string, WalkthroughStep][] = SET_IDS.flatMap((id) =>
  WALKTHROUGH_STEPS[id].map((step, index): [string, WalkthroughStep] => [
    `${id}[${index}] "${step.title}"`,
    step,
  ]),
);

/**
 * The markup EVERY alternative of a step's `target` needs to find in the source
 * tree. A target may be a selector list when the control it describes is
 * rendered as one of two fields (the calculator's risk basis), and a list is
 * only as good as its worst branch — so every branch is checked.
 */
function anchorsFor(target: string): string[] {
  return target.split(',').map((one) => anchorFor(one.trim()));
}

/** The markup a single selector needs to find in the source tree. */
function anchorFor(target: string): string {
  const id = /^#([A-Za-z][\w-]*)$/.exec(target);
  if (id) return `id="${id[1]}"`;
  const attrWithValue = /^\[([\w-]+)="([^"]+)"\]$/.exec(target);
  if (attrWithValue) return `${attrWithValue[1]}="${attrWithValue[2]}"`;
  const bareAttr = /^\[([\w-]+)\]$/.exec(target);
  if (bareAttr) return bareAttr[1];
  throw new Error(`Unsupported target selector shape: ${target}`);
}

describe('walkthrough step definitions', () => {
  it('covers all four checklist items, in order, with steps in each', () => {
    expect(Object.keys(WALKTHROUGH_STEPS)).toEqual([...SET_IDS]);
    for (const id of SET_IDS) expect(WALKTHROUGH_STEPS[id].length).toBeGreaterThan(0);
  });

  it.each(allSteps)('%s has a title and a body', (_name, step) => {
    expect(step.title.trim()).not.toBe('');
    // The body is everything before the appended anchor.
    expect(step.description.replace(/<a .*$/s, '').trim().length).toBeGreaterThan(20);
  });

  // R6.10 — every step deep-links to documentation, through docsUrl().
  it.each(allSteps)('%s carries exactly one docs link, built from docsUrl()', (_name, step) => {
    const hrefs = Array.from(step.description.matchAll(/href="([^"]+)"/g), (m) => m[1]);
    expect(hrefs).toEqual([docsUrl(step.docs)]);
    expect(step.description).toContain('target="_blank"');
    expect(step.description).toContain('rel="noreferrer"');
  });

  // R6.10 — and it resolves: the named page is a real page in apps/docs.
  it.each(allSteps)('%s links to a documentation page that exists', (_name, step) => {
    const href = docsUrl(step.docs);
    expect(href.startsWith(DOCS_BASE_URL)).toBe(true);

    const slug = DOCS[step.docs].replace(/^\/|\/$/g, '');
    const candidates = ['.mdx', '.md', '.markdown'].map((ext) =>
      path.join(DOCS_CONTENT, `${slug}${ext}`),
    );
    const found = candidates.some((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
    expect(found, `no page in apps/docs for ${href}`).toBe(true);
  });

  // R6.11 — no step anchors to a screen that does not exist. And R5.6 — that
  // screen has to be one `useWalkthrough` can NAVIGATE to, which membership of
  // the route tree alone does not establish: `/positions/$positionId` is the
  // router's PATTERN, and navigating to it verbatim is a 404. A step on a
  // parameterised route therefore has to name the params a caller must supply,
  // and a step that names none has to be on a route that needs none.
  //
  // This checks the two halves of that CONTRACT — the route is real, and the
  // param names match the pattern — and no more. It builds no URL: the values
  // are runtime state, so navigating for real is `useWalkthrough`'s to prove,
  // and the name below says only what is actually asserted here.
  it.each(allSteps)('%s names a real route, with a routeParam per $ segment', (_name, step) => {
    expect(routes.has(step.route), `unknown route ${step.route}`).toBe(true);
    const needed = Array.from(step.route.matchAll(/\$([A-Za-z]\w*)/g), (m) => m[1]);
    expect(
      step.routeParams ?? [],
      `${step.route} needs ${needed.join(', ') || 'no params'}`,
    ).toEqual(needed);
  });

  // R6.11 — and no step anchors to an element nobody renders.
  it.each(allSteps)('%s targets a selector the app actually renders', (_name, step) => {
    if (step.target === undefined) return; // A centred step is about the screen.
    for (const anchor of anchorsFor(step.target)) {
      expect(webSource.includes(anchor), `no source renders ${anchor} for ${step.target}`).toBe(
        true,
      );
    }
  });

  // R5.4 — a target that is not already on screen when its step is reached must
  // be waited for. Omitting `waitForMs` means "must already be there", and a
  // miss ends the tour on `target-missing`.
  //
  // THE FIRST STEP OF A SET IS INCLUDED, and that is the whole point. It used to
  // be exempt, on the assumption that a set opens on a screen already rendered.
  // That assumption is false in the one case that matters: a set is entered
  // COLD, from the checklist on another route, with the route still mounting and
  // the queries that render the target still in flight. Two first steps shipped
  // without a wait behind that exemption — `/positions` renders an untagged
  // disabled button until `useAccounts` lands, and `PositionDetail` renders
  // skeletons until `usePosition` does — so entering either set ended the tour
  // instantly. Anything the previous step did not leave on screen must wait.
  //
  // Derived as a LIST rather than looped over inside one `it`, so every step
  // that owes a wait is reported on its own: strip two waits and both are named,
  // where a loop stops at the first. Membership depends on `target`, `route` and
  // `advanceOnAction` only — never on `waitForMs` — so removing a wait cannot
  // remove the step from its own test.
  const stepsThatMustWait: [string, WalkthroughStep][] = SET_IDS.flatMap((id) =>
    WALKTHROUGH_STEPS[id].flatMap((step, index): [string, WalkthroughStep][] => {
      if (step.target === undefined) return [];
      const previous = WALKTHROUGH_STEPS[id][index - 1];
      const isNew =
        previous === undefined ||
        previous.route !== step.route ||
        previous.advanceOnAction === true;
      return isNew ? [[`${id}[${index}] "${step.title}"`, step]] : [];
    }),
  );

  it.each(stepsThatMustWait)('%s waits for its target', (name, step) => {
    // `?? 0` so a MISSING wait — the failure this exists to catch — reports
    // the step by name rather than a bare "received undefined".
    expect(step.waitForMs ?? 0, `${name} must wait for its target`).toBeGreaterThan(0);
  });

  // The library substitutes onDoneClick for onNextClick on the last step, so an
  // action-gated final step would trap the user behind an action with no exit
  // but Escape (tour-engine.ts, TourStep.advanceOnAction).
  it('never gates the last step of a set on an action', () => {
    for (const id of SET_IDS) {
      const steps = WALKTHROUGH_STEPS[id];
      expect(steps[steps.length - 1].advanceOnAction ?? false).toBe(false);
    }
  });

  // The step sets are content. Anything that would make them need a DOM, React
  // or the tour library belongs in tour-engine.ts, not here.
  it.each(['account', 'calculator', 'position', 'close', 'index'])(
    '%s.ts imports no React, no driver.js and no documentation host',
    (file) => {
      const source = readFileSync(path.join(__dirname, `${file}.ts`), 'utf8');
      expect(source).not.toMatch(/from 'react'|from 'driver\.js'/);
      // Only steps/index.ts may name a docs page, and only via docsUrl().
      expect(source.replace(/^ \*.*$/gm, '')).not.toContain('https://');
    },
  );

  it('exposes every step as a plain TourStep the engine can drive', () => {
    const allowed = new Set([
      'target',
      'title',
      'description',
      'side',
      'align',
      'waitForMs',
      'advanceOnAction',
      'docs',
      'route',
      'routeParams',
    ]);
    for (const [name, step] of allSteps) {
      for (const key of Object.keys(step)) {
        expect(allowed.has(key), `${name} carries unexpected key ${key}`).toBe(true);
      }
    }
  });
});

// A page named by a step must not be one of the placeholder pages apps/docs
// ships to show the shape of the documentation — "read more" that lands on
// "this page is not written yet" is worse than no link at all.
describe('walkthrough documentation targets', () => {
  const pages = new Set<DocsPage>(allSteps.map(([, step]) => step.docs));

  it.each([...pages])('%s is a written page, not a placeholder', (page) => {
    const slug = DOCS[page].replace(/^\/|\/$/g, '');
    const source = readFileSync(path.join(DOCS_CONTENT, `${slug}.mdx`), 'utf8');
    expect(source).not.toContain('This page is not written yet');
  });
});

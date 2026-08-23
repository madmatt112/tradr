// @vitest-environment jsdom
//
// Two suites in one file, on purpose.
//
// The first is about BEHAVIOUR — when the mark appears, what dismissing it
// writes, and the two hardest properties to see, which are both properties of
// things NOT happening (focus is not taken, the page is not blocked, nothing
// renders while a tour runs). Those cannot be read off the source, so they are
// exercised against a real Radix popover.
//
// The second is about COPY, and it is the walkthrough's own copy rule applied
// to the coach marks: no mark may name a control that is not on the screen it
// points at. Prose cannot be checked mechanically but the control labels inside
// it can, so each one is looked up in the source of the surface that renders
// it. A rename in `PositionDetail`, `DashboardHeader` or `CommitPanel` fails
// this file rather than shipping a mark that describes a button nobody has.
//
// The hooks are faked. `useOnboarding.test.ts` already owns the round trip
// (22 cases, including the singular-`coachMarkSeen` append and its
// idempotence), and re-testing it here would only assert the fake.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState } from '@tradr/shared';

import { docsUrl, DOCS, DOCS_BASE_URL } from '@/lib/docs';

import { useOnboardingQuery, useOnboardingPatch } from '../hooks/useOnboarding';
import { useIsWalkthroughRunning } from '../hooks/useWalkthrough';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useOnboarding', () => ({
  useOnboardingQuery: vi.fn(),
  useOnboardingPatch: vi.fn(),
}));
vi.mock('../hooks/useWalkthrough', () => ({ useIsWalkthroughRunning: vi.fn() }));

// The device latch is keyed by the signed-in user's id; a static stub keeps
// the component mountable without the auth stack. localStorage is cleared in
// beforeEach, so the latch never leaks between tests.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'test@example.com' } }),
}));

import { CoachMark, type CoachMarkSurface } from './CoachMark';

const mockQuery = vi.mocked(useOnboardingQuery);
const mockPatch = vi.mocked(useOnboardingPatch);
const mockRunning = vi.mocked(useIsWalkthroughRunning);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const WEB_SRC = path.join(REPO_ROOT, 'apps/web/src');
const DOCS_CONTENT = path.join(REPO_ROOT, 'apps/docs/src/content/docs');

function read(relativeToWebSrc: string): string {
  return readFileSync(path.join(WEB_SRC, relativeToWebSrc), 'utf8');
}

let patchMutate: ReturnType<typeof vi.fn>;

/** Seed the faked preference read. `undefined` models "not landed yet". */
function seePreference(state: OnboardingState | undefined): void {
  mockQuery.mockReturnValue({ data: state } as ReturnType<typeof useOnboardingQuery>);
}

function preference(coachMarksSeen: string[] = []): OnboardingState {
  return { status: 'active', coachMarksSeen };
}

beforeEach(() => {
  // The device latch persists in localStorage; without this, one test's
  // dismissal hides the mark for every test after it.
  localStorage.clear();
  patchMutate = vi.fn();
  mockPatch.mockReturnValue({ mutate: patchMutate } as unknown as ReturnType<
    typeof useOnboardingPatch
  >);
  mockRunning.mockReturnValue(false);
  seePreference(preference());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mark(surface: CoachMarkSurface = 'csv-import'): HTMLElement | null {
  return screen.queryByTestId(`coach-mark-${surface}`);
}

describe('CoachMark', () => {
  it('shows on first arrival at a surface the user has not dismissed', () => {
    render(<CoachMark surface="csv-import" />);
    expect(mark()).not.toBeNull();
    expect(mark()?.textContent).toContain('Bring your history in from a CSV');
  });

  it('stays away once the surface is in the stored seen set', () => {
    seePreference(preference(['csv-import']));
    render(<CoachMark surface="csv-import" />);
    expect(mark()).toBeNull();
  });

  it('keys the seen set per surface — one dismissal does not silence the others', () => {
    seePreference(preference(['csv-import']));
    render(
      <>
        <CoachMark surface="csv-import" />
        <CoachMark surface="options-tools" />
      </>,
    );
    expect(mark('csv-import')).toBeNull();
    expect(mark('options-tools')).not.toBeNull();
  });

  it('renders nothing until the preference read lands — an unknown answer is not "unseen"', () => {
    seePreference(undefined);
    render(<CoachMark surface="csv-import" />);
    expect(mark()).toBeNull();
  });

  it('renders nothing while a walkthrough is running, and never mounts to do it', () => {
    mockRunning.mockReturnValue(true);
    render(<CoachMark surface="dashboard-widgets" />);
    // Not "hidden": absent. Nothing was painted for the tour's highlight to
    // fight with, on this or any frame.
    expect(mark('dashboard-widgets')).toBeNull();
    expect(document.querySelector('[data-slot="coach-mark-anchor"]')).toBeNull();
  });

  it('renders nothing when the caller reports the feature unavailable', () => {
    render(<CoachMark surface="csv-import" available={false} />);
    expect(mark()).toBeNull();
  });

  it('dismisses on "Got it", appending exactly one singular key and nothing else', async () => {
    const user = userEvent.setup();
    render(<CoachMark surface="position-partials" />);

    await user.click(screen.getByRole('button', { name: 'Got it' }));

    expect(mark('position-partials')).toBeNull();
    expect(patchMutate).toHaveBeenCalledTimes(1);
    // SINGULAR, and the whole body. A `status` or a plural `coachMarksSeen`
    // here would make a coach mark into checklist state, which is the one thing
    // these are not.
    expect(patchMutate).toHaveBeenCalledWith({ coachMarkSeen: 'position-partials' });
  });

  it('treats Escape as a dismissal too, so a one-shot prompt is genuinely one-shot', async () => {
    const user = userEvent.setup();
    render(<CoachMark surface="options-tools" />);

    await user.keyboard('{Escape}');

    expect(mark('options-tools')).toBeNull();
    expect(patchMutate).toHaveBeenCalledWith({ coachMarkSeen: 'options-tools' });
  });

  it('does not take focus when it appears', () => {
    // The real sequence: the surface renders and the user starts working, THEN
    // the preference read lands and the mark appears. If it grabbed focus it
    // would take the caret out of the field mid-keystroke.
    seePreference(undefined);
    const { rerender } = render(
      <>
        <input aria-label="Symbol" />
        <CoachMark surface="csv-import" />
      </>,
    );
    const field = screen.getByLabelText('Symbol');
    field.focus();
    expect(document.activeElement).toBe(field);

    seePreference(preference());
    rerender(
      <>
        <input aria-label="Symbol" />
        <CoachMark surface="csv-import" />
      </>,
    );

    expect(mark()).not.toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('does not block the surface it describes, and clicking it through dismisses', async () => {
    const user = userEvent.setup();
    const onSurfaceClick = vi.fn();
    render(
      <>
        <button type="button" onClick={onSurfaceClick}>
          Add Fill
        </button>
        <CoachMark surface="position-partials" />
      </>,
    );

    // THE MARK IS UP FIRST, and this assertion is what stops the rest of the
    // case being vacuous: a mark that never rendered blocks nothing either, so
    // every assertion below would pass just as happily against no mark at all.
    expect(mark('position-partials')).not.toBeNull();

    // Radix only makes the rest of the page inert when the popover is modal.
    // Asserting the body directly is the concrete form of "non-blocking": a
    // modal popover sets this to 'none'.
    expect(document.body.style.pointerEvents).not.toBe('none');

    // AND THE CARD IS OUT OF THE POINTER PATH, which is the half of "does not
    // block" this environment cannot otherwise reach. jsdom has no layout:
    // nothing here overlaps anything, so the click below lands on the button
    // whether or not an opaque popover is sitting on top of it in a real
    // browser — which is exactly what happened, and what let the import page
    // ship with its mark covering the account picker. This assertion pins the
    // MECHANISM; the behaviour is pinned where geometry exists, in
    // `e2e/tests/user-onboarding.spec.ts` ("a coach mark does not stand between
    // the user and the control it describes"), which drives a real click at the
    // covered control.
    expect(mark('position-partials')?.className).toContain('pointer-events-none');

    await user.click(screen.getByRole('button', { name: 'Add Fill' }));

    expect(onSurfaceClick).toHaveBeenCalledTimes(1);
    expect(mark('position-partials')).toBeNull();
  });

  it('leaves its own two controls clickable through the transparent card', () => {
    // The other side of `pointer-events-none`: opting the card out entirely
    // would take "Got it" and "Read more" out with it, and a prompt nobody can
    // acknowledge is not one-shot at all.
    render(<CoachMark surface="csv-import" />);

    expect(screen.getByRole('button', { name: 'Got it' }).className).toContain(
      'pointer-events-auto',
    );
    expect(screen.getByRole('link', { name: 'Read more' }).className).toContain(
      'pointer-events-auto',
    );
  });

  it('carries its docs deep link through docsUrl(), in a new tab', () => {
    render(<CoachMark surface="csv-import" />);
    const link = screen.getByRole('link', { name: 'Read more' });
    expect(link.getAttribute('href')).toBe(docsUrl('importHistory'));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    // The host is written down in docs.ts and nowhere else.
    expect(read('features/onboarding/components/CoachMark.tsx')).not.toContain(DOCS_BASE_URL);
  });
});

// ---------------------------------------------------------------------------
// The walkthrough's copy rule applied to the coach marks: every control the
// copy names is a control the surface actually renders, checked against that
// surface's source.
// ---------------------------------------------------------------------------

describe('CoachMark device latch (visual-redesign task 6)', () => {
  it('stays dismissed across a reload even when the PATCH never lands', async () => {
    const user = userEvent.setup();
    render(<CoachMark surface="dashboard-widgets" />);
    expect(mark('dashboard-widgets')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(mark('dashboard-widgets')).toBeNull();
    cleanup();

    // A fresh mount with the server record still unchanged models the next
    // page load after a failed or in-flight PATCH — the resurrection this
    // latch exists to end.
    seePreference(preference());
    render(<CoachMark surface="dashboard-widgets" />);
    expect(mark('dashboard-widgets')).toBeNull();
  });

  it('does not hide the mark from a different user on the same device', async () => {
    const user = userEvent.setup();
    render(<CoachMark surface="dashboard-widgets" />);
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    cleanup();

    // Another account's id in the latch must not match: the latch stores WHO
    // dismissed, so a shared machine cannot silence a mark the second user
    // never saw.
    localStorage.setItem('coach-mark-dismissed:dashboard-widgets', 'someone-else');
    seePreference(preference());
    render(<CoachMark surface="dashboard-widgets" />);
    expect(mark('dashboard-widgets')).not.toBeNull();
  });
});

describe('CoachMark copy is accurate against the shipped UI', () => {
  function bodyOf(surface: CoachMarkSurface): string {
    render(<CoachMark surface={surface} />);
    const text = mark(surface)?.textContent ?? '';
    cleanup();
    return text;
  }

  const NAMED_CONTROLS: Record<CoachMarkSurface, Array<[string, string]>> = {
    // [phrase in the mark, file that must contain it]
    'position-partials': [
      ['Add Fill', 'features/positions/components/PositionDetail.tsx'],
      ['Close Position', 'features/positions/components/PositionDetail.tsx'],
    ],
    'csv-import': [
      ['Imports are additive', 'features/csv-import/components/ImportPage.tsx'],
      ['Pick a preset', 'features/csv-import/components/ImportPage.tsx'],
    ],
    'options-tools': [
      ['Black-Scholes', 'features/options/components/BlackScholesCard.tsx'],
      ['OCC', 'features/options/components/OccCard.tsx'],
    ],
    'dashboard-widgets': [
      ['Add Widget', 'features/dashboard/components/AddWidgetPopover.tsx'],
      ['Reset layout', 'features/dashboard/components/DashboardHeader.tsx'],
    ],
  };

  const surfaces = Object.keys(NAMED_CONTROLS) as CoachMarkSurface[];

  it.each(surfaces)('%s names only controls its surface renders', (surface) => {
    const body = bodyOf(surface);
    for (const [phrase, file] of NAMED_CONTROLS[surface]) {
      expect(body).toContain(phrase);
      expect(read(file)).toContain(phrase);
    }
  });

  it.each(surfaces)('%s says something worth reading', (surface) => {
    // Title plus body plus the buttons — enough to be a sentence, not a label.
    expect(bodyOf(surface).length).toBeGreaterThan(80);
  });

  it('links only to documentation pages that are actually written', () => {
    for (const surface of surfaces) {
      render(<CoachMark surface={surface} />);
      const link = screen.queryByRole('link', { name: 'Read more' });
      if (link !== null) {
        const page = (Object.keys(DOCS) as Array<keyof typeof DOCS>).find(
          (key) => docsUrl(key) === link.getAttribute('href'),
        );
        expect(page).toBeDefined();
        const slug = DOCS[page!].replace(/^\/|\/$/g, '');
        const source = readFileSync(path.join(DOCS_CONTENT, `${slug}.mdx`), 'utf8');
        // The rule steps.test.ts already enforces for the walkthrough: a "read
        // more" that lands on "this page is not written yet" is worse than no
        // link at all.
        expect(source).not.toContain('This page is not written yet');
      }
      cleanup();
    }
  });

  it('omits the options-tools link ONLY because its docs page is still a stub', () => {
    // The one mark with no "read more". When apps/docs grows a real
    // user-guide/options-tools page this test fails — that is the reminder to
    // add `docs: 'optionsTools'` to the catalog and the entry to DOCS.
    render(<CoachMark surface="options-tools" />);
    expect(screen.queryByRole('link', { name: 'Read more' })).toBeNull();

    const source = readFileSync(path.join(DOCS_CONTENT, 'user-guide/options-tools.mdx'), 'utf8');
    expect(source).toContain('This page is not written yet');
  });
});

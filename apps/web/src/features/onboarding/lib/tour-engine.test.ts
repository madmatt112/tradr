import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { advance, isActive, startTour, stop, type TourStep } from './tour-engine';

/**
 * jsdom (the `web` project default) is enough here: driver.js only ever reads
 * `getBoundingClientRect`, which returns zeroes, and its scroll helper bails out
 * when the element is already "in view" — which every zero-sized rect is. So the
 * whole lifecycle runs without a layout engine.
 */

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mountTargets(...ids: string[]): void {
  document.body.innerHTML = ids.map((id) => `<button id="${id}">${id}</button>`).join('');
}

function popoverTitle(): string | undefined {
  return document.querySelector('.driver-popover-title')?.textContent ?? undefined;
}

function clickPopoverButton(selector: string): void {
  document.querySelector<HTMLButtonElement>(selector)?.click();
}

/**
 * The third way out, and the one no test reached: clicking the dimmed page
 * around the highlight.
 *
 * driver.js paints that dimming as a `<path>` inside its overlay `<svg>` and
 * only treats a click as an overlay click when the path itself was the target,
 * so the event has to come from there. It ends the tour through
 * `onDestroyStarted` rather than through a popover button — a separate route
 * into `stop()`, carrying its own step index.
 *
 * Awaited, unlike the popover: the overlay is painted from the animation frame
 * that follows the highlight rather than during it, so it is the one part of a
 * tour that is not on screen the moment `startTour` returns.
 */
async function clickOverlay(): Promise<void> {
  const dimming = await vi.waitUntil(() => document.querySelector('.driver-overlay path'));
  dimming.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const TWO_STEPS: TourStep[] = [
  { target: '#one', title: 'First', description: 'The first control.' },
  { target: '#two', title: 'Second', description: 'The second control.' },
];

beforeEach(() => {
  // Reduced motion keeps driver.js's rendering synchronous (it defers the
  // popover to a rAF frame only while animating), so these tests assert on the
  // DOM without waiting. The two animation tests set their own value.
  stubReducedMotion(true);
  mountTargets('one', 'two');
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('startTour', () => {
  it('drives a tour end to end, then reports completion', () => {
    const onStepChange = vi.fn();
    const onExit = vi.fn();

    startTour(TWO_STEPS, { onStepChange, onExit });

    expect(isActive()).toBe(true);
    expect(onStepChange).toHaveBeenLastCalledWith(0, TWO_STEPS[0]);
    expect(popoverTitle()).toBe('First');

    advance();
    expect(onStepChange).toHaveBeenLastCalledWith(1, TWO_STEPS[1]);
    expect(popoverTitle()).toBe('Second');
    expect(onExit).not.toHaveBeenCalled();

    advance();
    expect(isActive()).toBe(false);
    expect(onExit).toHaveBeenCalledExactlyOnceWith('completed', undefined);
    expect(document.querySelector('.driver-popover')).toBeNull();
  });

  it('shows progress and leaves the highlighted control interactive', () => {
    startTour(TWO_STEPS);

    // An action step asks the user to press the thing it highlights, so the
    // control must stay usable — hence `disableActiveInteraction: false`.
    // driver.js blocks the spotlit control by tagging it
    // `driver-no-interaction` (a `pointer-events: none` rule); its absence on
    // the highlighted element is the observable proof the control is still
    // clickable. Asserting a jsdom `.click()` would not be — jsdom dispatches
    // regardless of CSS.
    const highlighted = document.querySelector('#one');
    expect(highlighted?.classList.contains('driver-active-element')).toBe(true);
    expect(highlighted?.classList.contains('driver-no-interaction')).toBe(false);

    // The non-motion carrier of step state.
    expect(document.querySelector('.driver-popover-progress-text')?.textContent).toBe('1 of 2');
  });

  it('ends a tour already running before starting the new one', () => {
    const firstExit = vi.fn();
    startTour(TWO_STEPS, { onExit: firstExit });

    startTour([{ target: '#two', title: 'Only', description: 'Alone.' }]);

    expect(firstExit).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
    expect(isActive()).toBe(true);
    expect(popoverTitle()).toBe('Only');
  });

  it('is a no-op when handed no steps', () => {
    startTour([]);
    expect(isActive()).toBe(false);
    expect(document.querySelector('.driver-popover')).toBeNull();
  });
});

describe('action steps', () => {
  const steps: TourStep[] = [
    { target: '#one', title: 'Do it', description: 'Create the thing.', advanceOnAction: true },
    { target: '#two', title: 'Done', description: 'Here it is.' },
  ];

  it('does not advance on "Next"', () => {
    const onStepChange = vi.fn();
    startTour(steps, { onStepChange });

    clickPopoverButton('.driver-popover-next-btn');

    expect(onStepChange).toHaveBeenCalledExactlyOnceWith(0, steps[0]);
    expect(popoverTitle()).toBe('Do it');
  });

  it('advances when the caller reports the action completed', () => {
    startTour(steps);

    advance();

    expect(popoverTitle()).toBe('Done');
  });

  it('still advances a non-action step on "Next"', () => {
    startTour(TWO_STEPS);

    clickPopoverButton('.driver-popover-next-btn');

    expect(popoverTitle()).toBe('Second');
  });

  // The trap this releases: the rest of the page is inert under a running tour,
  // so a gated step pointing at a control the user cannot press leaves Escape —
  // which ENDS the walkthrough — as the only way on. The close set reaches it
  // whenever the user takes the partial exit its previous step invites.
  it('releases the gate while the highlighted control is disabled', () => {
    document.querySelector<HTMLButtonElement>('#one')!.disabled = true;
    startTour(steps);

    clickPopoverButton('.driver-popover-next-btn');
    expect(popoverTitle()).toBe('Done');
  });

  it('releases it for the right-arrow key on the same terms', () => {
    document.querySelector<HTMLButtonElement>('#one')!.disabled = true;
    startTour(steps);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    expect(popoverTitle()).toBe('Done');
  });

  it('reads the control live, so a gate closes again once it can be pressed', () => {
    const target = document.querySelector<HTMLButtonElement>('#one')!;
    target.disabled = true;
    startTour(steps);

    target.disabled = false;
    clickPopoverButton('.driver-popover-next-btn');
    expect(popoverTitle()).toBe('Do it');
  });

  // Radix marks its own disabled triggers this way rather than with the
  // attribute, and they are just as unpressable.
  it('counts an aria-disabled control as one the user cannot press', () => {
    document.querySelector('#one')!.setAttribute('aria-disabled', 'true');
    startTour(steps);

    clickPopoverButton('.driver-popover-next-btn');
    expect(popoverTitle()).toBe('Done');
  });
});

/**
 * The caller's chance to put the next step's screen up before the tour moves
 * onto it. Only for a move the USER made: a caller driving the tour with
 * `advance()` has already prepared, and firing here as well would do it twice.
 */
describe('onBeforeAdvance', () => {
  it('fires before a "Next" press moves the tour, naming the outgoing step', () => {
    const onBeforeAdvance = vi.fn(() => {
      expect(popoverTitle()).toBe('First');
    });
    startTour(TWO_STEPS, { onBeforeAdvance });

    clickPopoverButton('.driver-popover-next-btn');

    expect(onBeforeAdvance).toHaveBeenCalledExactlyOnceWith(0);
    expect(popoverTitle()).toBe('Second');
  });

  it('fires on the right-arrow key too', () => {
    const onBeforeAdvance = vi.fn();
    startTour(TWO_STEPS, { onBeforeAdvance });

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));

    expect(onBeforeAdvance).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('does not fire when the caller advances the tour itself', () => {
    const onBeforeAdvance = vi.fn();
    startTour(TWO_STEPS, { onBeforeAdvance });

    advance();

    expect(onBeforeAdvance).not.toHaveBeenCalled();
    expect(popoverTitle()).toBe('Second');
  });

  it('does not fire on the last step, where the press is "Done"', () => {
    const onBeforeAdvance = vi.fn();
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onBeforeAdvance, onExit });
    advance();

    clickPopoverButton('.driver-popover-next-btn');

    expect(onBeforeAdvance).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledExactlyOnceWith('completed', undefined);
  });
});

/**
 * The keyboard is the engine's own, not driver.js's.
 *
 * driver.js drops an arrow press while a step transition is running, so a
 * keyboard user lost roughly every other press while a mouse user lost none —
 * "Next" has no such guard. These pin the behaviour that replaced it. The drop
 * itself is a timing property of the animation and belongs to the e2e suite;
 * what is checkable here is that one press moves exactly one step, that the
 * action gate applies to the key as well as the button, and that the binding
 * goes away with the tour.
 */
describe('keyboard control', () => {
  function press(key: string): void {
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }

  it('advances exactly one step per right-arrow press', () => {
    const onStepChange = vi.fn();
    startTour(TWO_STEPS, { onStepChange });

    press('ArrowRight');

    expect(popoverTitle()).toBe('Second');
    expect(onStepChange).toHaveBeenLastCalledWith(1, TWO_STEPS[1]);
    expect(onStepChange).toHaveBeenCalledTimes(2);
  });

  it('goes back on the left arrow, and stays put at the front of the set', () => {
    startTour(TWO_STEPS);
    press('ArrowRight');
    expect(popoverTitle()).toBe('Second');

    press('ArrowLeft');
    expect(popoverTitle()).toBe('First');

    // Off the front is a no-op, NOT an exit: `movePrevious()` there would tear
    // the tour down, which is not what the key means.
    press('ArrowLeft');
    expect(popoverTitle()).toBe('First');
    expect(isActive()).toBe(true);
  });

  it('leaves an action step where it is, exactly as "Next" does', () => {
    startTour([
      { target: '#one', title: 'Do it', description: 'Create the thing.', advanceOnAction: true },
      { target: '#two', title: 'Done', description: 'Here it is.' },
    ]);

    press('ArrowRight');

    expect(popoverTitle()).toBe('Do it');
  });

  it('stops listening once the tour has ended', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });
    stop();

    press('ArrowRight');
    press('Escape');

    expect(onExit).toHaveBeenCalledOnce();
    expect(isActive()).toBe(false);
  });
});

describe('exiting', () => {
  it('reports a dismissal from the close button', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    clickPopoverButton('.driver-popover-close-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
    expect(isActive()).toBe(false);
  });

  it('reports a dismissal from a click on the overlay', async () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    await clickOverlay();

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
    expect(isActive()).toBe(false);
    expect(document.querySelector('.driver-overlay')).toBeNull();
  });

  it('reports a dismissal from Escape', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
    expect(isActive()).toBe(false);
  });

  it('reports completion from the last step’s "Done" button', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });
    advance();

    clickPopoverButton('.driver-popover-next-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('completed', undefined);
    expect(isActive()).toBe(false);
  });
});

/**
 * LEAVING A STEP THAT WOULD ONLY MOVE ON AN ACTION IS NOT AN ORDINARY EXIT, and
 * the difference is the whole of this defect. On a gated step "Next" is inert,
 * so the close button is the only control that answers the user at all —
 * whereas on any other step it is one of three ways on that they chose not to
 * take. Naming the step here is what lets the caller say why the tour stopped
 * instead of leaving the screen bare, which is how this has failed three times.
 *
 * AND NAMING IT IS NOT ENOUGH: the engine says WHICH of the two things held the
 * user, because the caller cannot tell from the step or from the reason, and
 * both of those readings have already shipped as the wrong answer.
 */
describe('the step the user could not get past', () => {
  const gated: TourStep[] = [
    { target: '#one', title: 'Do it', description: 'Create the thing.', advanceOnAction: true },
    { target: '#two', title: 'Done', description: 'Here it is.' },
  ];

  const declined = { cause: 'action-required', step: gated[0] };

  it('is reported when the close button ends a gated step', () => {
    const onExit = vi.fn();
    startTour(gated, { onExit });

    clickPopoverButton('.driver-popover-close-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', declined);
  });

  it('is reported when Escape ends one', () => {
    const onExit = vi.fn();
    startTour(gated, { onExit });

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', declined);
  });

  it('is reported when a click on the overlay ends one', async () => {
    const onExit = vi.fn();
    startTour(gated, { onExit });

    await clickOverlay();

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', declined);
  });

  // The overlay ends the tour through a different hook from the other two, and
  // that hook is handed its own step index — so this is the one place the index
  // could be wrong without any other test noticing. Leaving the tour on step 1
  // is what tells a read of `opts.index` apart from a hard-coded first step.
  it('names the step the overlay click actually landed on', async () => {
    const onExit = vi.fn();
    const secondIsGated: TourStep[] = [
      { target: '#one', title: 'First', description: 'The first control.' },
      { target: '#two', title: 'Do it', description: 'Create the thing.', advanceOnAction: true },
    ];
    startTour(secondIsGated, { onExit });
    advance();

    await clickOverlay();

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', {
      cause: 'action-required',
      step: secondIsGated[1],
    });
  });

  /**
   * A CONTROL THAT HAS GONE IS NOT A USER WHO DECLINED, and reading it as one is
   * the same mistake as the two before it, one level further down: the engine
   * recorded the gate for a step whose control had unmounted, so the caller was
   * handed "the user did not do it" for a button that was no longer there.
   *
   * Reachable in the product. `#symbol` is gated and lives in the new-position
   * dialog: cancel the dialog, then close the tour, and this is the path.
   */
  it('classifies a gated step whose control has gone as a missing target', () => {
    const onExit = vi.fn();
    startTour(gated, { onExit });
    // The dialog the control lived in, dismissed under the running tour.
    document.querySelector('#one')!.remove();

    clickPopoverButton('.driver-popover-close-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('target-missing', {
      cause: 'target-missing',
      step: gated[0],
    });
  });

  it('classifies it the same way when Escape ends it', () => {
    const onExit = vi.fn();
    startTour(gated, { onExit });
    document.querySelector('#one')!.remove();

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));

    expect(onExit).toHaveBeenCalledExactlyOnceWith('target-missing', {
      cause: 'target-missing',
      step: gated[0],
    });
  });

  // The gate itself is untouched by that classification, and must be: an absent
  // control is no more pressable than a disabled one, but handing "Next" back
  // here would advance a tour past a step the user was never shown. Only a
  // control that is ON SCREEN and unusable releases it.
  it('keeps the gate on a step whose control has gone', () => {
    startTour(gated);
    document.querySelector('#one')!.remove();

    clickPopoverButton('.driver-popover-next-btn');

    expect(popoverTitle()).toBe('Do it');
  });

  // The same test the gate itself is made of. A gated step whose control is
  // disabled hands "Next" back, so the user leaving that one had a way on and
  // declined it — there is nothing to explain, and explaining anyway would be
  // an interruption for a user who simply closed the tour.
  it('is not reported when the gate had already been released', () => {
    document.querySelector<HTMLButtonElement>('#one')!.disabled = true;
    const onExit = vi.fn();
    startTour(gated, { onExit });

    clickPopoverButton('.driver-popover-close-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
  });

  it('is not reported for an ordinary step', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    clickPopoverButton('.driver-popover-close-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
  });

  // A tour the APP took away, not one the user got stuck in: `startTour` ends
  // the previous tour through `stop()`, and so does the caller's own "end the
  // walkthrough". Reporting those would put an explanation on screen at the
  // moment the next tour starts.
  it('is not reported when the caller ends the tour itself', () => {
    const onExit = vi.fn();
    startTour(gated, { onExit });

    stop();

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
  });
});

describe('missing targets', () => {
  it('waits for a target that appears late, then anchors to it', async () => {
    const onStepChange = vi.fn();
    const steps: TourStep[] = [
      { target: '#one', title: 'First', description: 'Here.' },
      { target: '#late', title: 'Late', description: 'Arrived.', waitForMs: 1000 },
    ];

    startTour(steps, { onStepChange });
    advance();

    // Still waiting — no popover for the second step yet.
    expect(popoverTitle()).toBe('First');

    const late = document.createElement('button');
    late.id = 'late';
    document.body.appendChild(late);

    await vi.waitFor(() => expect(onStepChange).toHaveBeenLastCalledWith(1, steps[1]));
    expect(popoverTitle()).toBe('Late');
    expect(isActive()).toBe(true);
  });

  it('ends the tour cleanly when the target never appears', async () => {
    const onExit = vi.fn();
    const step: TourStep = {
      target: '#never',
      title: 'Nope',
      description: 'Absent.',
      waitForMs: 20,
    };
    startTour([step], { onExit });

    // The step it gave up on comes out with the reason, and this is the only
    // moment anyone could know it: `onStepChange` never fired for it, so the
    // caller's idea of the current step is still the one before.
    await vi.waitFor(() =>
      expect(onExit).toHaveBeenCalledExactlyOnceWith('target-missing', {
        cause: 'target-missing',
        step,
      }),
    );

    expect(isActive()).toBe(false);
    // No stuck overlay, and nothing was highlighted in its place.
    expect(document.querySelector('.driver-popover')).toBeNull();
    expect(document.querySelector('.driver-active-element')).toBeNull();
    expect(document.body.classList.contains('driver-active')).toBe(false);
  });

  it('names the step it gave up on, not the one it was showing', async () => {
    const onExit = vi.fn();
    const steps: TourStep[] = [
      { target: '#one', title: 'First', description: 'Here.' },
      { target: '#never', title: 'Unreachable', description: 'Absent.', waitForMs: 20 },
    ];
    startTour(steps, { onExit });

    advance();

    await vi.waitFor(() =>
      expect(onExit).toHaveBeenCalledExactlyOnceWith('target-missing', {
        cause: 'target-missing',
        step: steps[1],
      }),
    );
  });

  it('gives up immediately when a step declares no wait', async () => {
    const onExit = vi.fn();
    const step: TourStep = { target: '#never', title: 'Nope', description: 'Absent.' };
    startTour([step], { onExit });

    await vi.waitFor(() =>
      expect(onExit).toHaveBeenCalledExactlyOnceWith('target-missing', {
        cause: 'target-missing',
        step,
      }),
    );
    expect(isActive()).toBe(false);
  });

  it('runs a step with no target at all, centred', () => {
    const onStepChange = vi.fn();
    const steps: TourStep[] = [{ title: 'About this screen', description: 'No control.' }];

    startTour(steps, { onStepChange });

    expect(onStepChange).toHaveBeenCalledExactlyOnceWith(0, steps[0]);
    expect(isActive()).toBe(true);
  });
});

/**
 * ONE CONTROL IS THE HIGHLIGHTED ONE, AND A STEP CHANGE THAT ARRIVES EARLY MUST
 * NOT LEAVE A SECOND ONE BEHIND.
 *
 * `driver-active-element` carries the lock as well as the ring: `driver.css`
 * takes `pointer-events` off the whole page and gives them back to that element,
 * so a stale copy is a control the dimming says is locked and is not. driver.js
 * decides what to un-highlight from a value it only writes when a step's 400ms
 * transition finishes, so a press inside that window strands the class on the
 * control the abandoned transition had just moved to.
 *
 * ANIMATION ON IS THE POINT, not incidental: with `prefers-reduced-motion` the
 * engine passes `animate: false` and driver.js does its bookkeeping inline, so
 * the window does not exist and this test would pass against the bug. Every
 * other test here runs reduced — this one must not.
 */
describe('a highlight the tour has moved off', () => {
  it('is released even when the next step arrives before the transition ends', () => {
    stubReducedMotion(false);
    startTour(TWO_STEPS);
    expect(document.querySelector('#one')?.classList.contains('driver-active-element')).toBe(true);

    // No wait: the whole defect is the step change that lands inside the
    // previous step's transition.
    advance();

    expect(document.querySelectorAll('.driver-active-element')).toHaveLength(1);
    expect(document.querySelector('#two')?.classList.contains('driver-active-element')).toBe(true);
    // And the ARIA driver.js sets beside the class goes with it, or the control
    // the tour has left goes on announcing itself as the popover's trigger.
    expect(document.querySelector('#one')?.hasAttribute('aria-haspopup')).toBe(false);
    expect(document.querySelector('#one')?.getAttribute('aria-expanded')).toBeNull();
  });
});

describe('reduced motion', () => {
  it('disables animation when the user prefers reduced motion', () => {
    stubReducedMotion(true);
    startTour(TWO_STEPS);

    expect(document.body.classList.contains('driver-simple')).toBe(true);
    expect(document.body.classList.contains('driver-fade')).toBe(false);
  });

  it('animates otherwise', () => {
    stubReducedMotion(false);
    startTour(TWO_STEPS);

    expect(document.body.classList.contains('driver-fade')).toBe(true);
    expect(document.body.classList.contains('driver-simple')).toBe(false);
  });

  it('treats a missing matchMedia as "no preference" rather than throwing', () => {
    vi.stubGlobal('matchMedia', undefined);

    expect(() => startTour(TWO_STEPS)).not.toThrow();
    expect(isActive()).toBe(true);
  });
});

describe('an ending the tour itself cannot see', () => {
  // The session going away under a running tour. driver.js has no hook for it,
  // so the tracked reason would call it a dismissal — which is the answer to a
  // different question (whether the user wanted the walkthrough).
  it('reports the reason the caller passed instead of the tracked one', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    stop('session-ended');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('session-ended', undefined);
  });

  it('still reports the tracked reason when the caller names none', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    clickPopoverButton('.driver-popover-close-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed', undefined);
  });

  /**
   * An ending the caller named is not the user stuck on a step, so it carries no
   * classification either — even when one has already been taken. Forwarding it
   * would explain a walkthrough the session took away, to a user who is by then
   * looking at the login screen.
   *
   * The window is real rather than theoretical: giving up on a target records
   * the classification and defers the teardown by a tick, so a logout landing in
   * between finds one waiting. The fake clock holds that tick open.
   */
  it('carries no classification for an ending the caller named', () => {
    const onExit = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      startTour([{ target: '#never', title: 'Nope', description: 'Absent.' }], { onExit });

      stop('session-ended');

      expect(onExit).toHaveBeenCalledExactlyOnceWith('session-ended', undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The stylesheet this module imports is loaded for the rest of the SESSION, not
 * for the tour — nothing unloads it when the tour ends. So every rule in it that
 * hands `pointer-events` back has to be scoped to `.driver-active`, the class
 * driver.js keeps on `<body>` for exactly as long as a tour is running.
 *
 * Unscoped, the dialog-release rules outrank `disabled:pointer-events-none` and
 * `data-[disabled]:pointer-events-none` and go on doing so in every dialog the
 * user opens afterwards, which turns disabled controls back into clickable ones
 * in an app that is no longer running a tour. Checked as text because jsdom
 * applies no stylesheet — the behaviour itself is asserted in the e2e suite.
 */
describe('tour.css scoping', () => {
  const css = readFileSync(path.join(__dirname, '../tour.css'), 'utf8');

  // Declaration blocks only: the file's prose explains these rules at length,
  // and a comment naming a selector is not a selector.
  const selectors = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .flatMap((block) => block.split('{')[0].split(','))
    // One selector per entry, whitespace collapsed: a list is only as scoped as
    // its loosest branch, so every branch is checked on its own.
    .map((selector) => selector.trim().replace(/\s+/g, ' '))
    .filter((selector) => selector.length > 0 && !selector.startsWith('@'));

  it('has rules that release pointer-events while a dialog is open', () => {
    // The guard below passes vacuously if the rules are renamed out from under
    // it, so this is the check that there is still something to scope.
    expect(selectors.filter((s) => s.includes("[data-slot='dialog-content']")).length).toBe(3);
  });

  it.each(selectors.filter((s) => s.includes("[data-slot='dialog-content']")))(
    'scopes %s to a running tour',
    (selector) => {
      expect(selector).toContain('.driver-active');
    },
  );
});

describe('idle engine', () => {
  it('advance, stop and isActive are safe with no tour running', () => {
    expect(isActive()).toBe(false);
    expect(() => advance()).not.toThrow();
    expect(() => stop()).not.toThrow();
    expect(isActive()).toBe(false);
  });

  it('does not fire onExit twice when stopped after it already ended', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    clickPopoverButton('.driver-popover-close-btn');
    stop();
    stop();

    expect(onExit).toHaveBeenCalledOnce();
  });
});

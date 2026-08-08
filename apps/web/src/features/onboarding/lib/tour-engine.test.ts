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
    expect(onExit).toHaveBeenCalledExactlyOnceWith('completed');
    expect(document.querySelector('.driver-popover')).toBeNull();
  });

  it('shows progress and leaves the highlighted control interactive', () => {
    startTour(TWO_STEPS);

    // R5.5 — `disableActiveInteraction: false`. driver.js blocks the spotlit
    // control by tagging it `driver-no-interaction` (a `pointer-events: none`
    // rule); its absence on the highlighted element is the observable proof the
    // control is still clickable. Asserting a jsdom `.click()` would not be —
    // jsdom dispatches regardless of CSS.
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

    expect(firstExit).toHaveBeenCalledExactlyOnceWith('dismissed');
    expect(isActive()).toBe(true);
    expect(popoverTitle()).toBe('Only');
  });

  it('is a no-op when handed no steps', () => {
    startTour([]);
    expect(isActive()).toBe(false);
    expect(document.querySelector('.driver-popover')).toBeNull();
  });
});

describe('action steps (R5.5)', () => {
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
});

describe('exiting (R5.3)', () => {
  it('reports a dismissal from the close button', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    clickPopoverButton('.driver-popover-close-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed');
    expect(isActive()).toBe(false);
  });

  it('reports a dismissal from Escape', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed');
    expect(isActive()).toBe(false);
  });

  it('reports completion from the last step’s "Done" button', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });
    advance();

    clickPopoverButton('.driver-popover-next-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('completed');
    expect(isActive()).toBe(false);
  });
});

describe('missing targets (R5.4)', () => {
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
    startTour([{ target: '#never', title: 'Nope', description: 'Absent.', waitForMs: 20 }], {
      onExit,
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledExactlyOnceWith('target-missing'));

    expect(isActive()).toBe(false);
    // No stuck overlay, and nothing was highlighted in its place.
    expect(document.querySelector('.driver-popover')).toBeNull();
    expect(document.querySelector('.driver-active-element')).toBeNull();
    expect(document.body.classList.contains('driver-active')).toBe(false);
  });

  it('gives up immediately when a step declares no wait', async () => {
    const onExit = vi.fn();
    startTour([{ target: '#never', title: 'Nope', description: 'Absent.' }], { onExit });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledExactlyOnceWith('target-missing'));
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

describe('reduced motion (R5.9)', () => {
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

    expect(onExit).toHaveBeenCalledExactlyOnceWith('session-ended');
  });

  it('still reports the tracked reason when the caller names none', () => {
    const onExit = vi.fn();
    startTour(TWO_STEPS, { onExit });

    clickPopoverButton('.driver-popover-close-btn');

    expect(onExit).toHaveBeenCalledExactlyOnceWith('dismissed');
  });
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

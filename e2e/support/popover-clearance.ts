/**
 * DOES THE PROMPT ON SCREEN STAND ON TOP OF ANYTHING THE USER CAN STILL PRESS?
 *
 * The onboarding surfaces have now shipped six separate versions of one defect:
 * a walkthrough popover or a coach mark laid over a control. A combobox on the
 * import screen, the fill dialog's Add button twice, the account dialog's
 * neighbouring fields, the checklist's play button. Each was found by a person,
 * fixed on its own, and pinned by a test naming that one control — so the next
 * one had nothing to fail against and was found by a person too.
 *
 * The reason a per-control test cannot close it is that each fix asserted the
 * control the CURRENT STEP DESCRIBES is clear. Every one of these defects was a
 * control the step said nothing about: the neighbour, the Cancel, the button
 * that restarts the walkthrough. Nobody writes an assertion for a control their
 * step is not about, which is exactly the set the defect lives in.
 *
 * So this measures the prompt against EVERY control the user could press at that
 * moment, and the caller names none of them.
 *
 * WHAT COUNTS AS "COULD PRESS", AND WHY IT IS NOT "IS ON SCREEN". A running tour
 * deliberately locks the page: driver.js drops `pointer-events` on everything and
 * hands them back to the highlighted control, the popover, and — because
 * `tour.css` says so — to a dialog the tour itself told the user to open. A
 * popover lying over a widget the tour has already made inert blocks nothing;
 * the wash over it says so on screen. A popover lying over the Currency field of
 * the open account dialog blocks a control the user can see, can tab to, and
 * would expect to click. Those are different things, and only the second is a
 * defect. The test for it is the element's own resolved `pointer-events`, which
 * is the same value the browser decides hit-testing by.
 *
 * WHAT COUNTS AS "THE PROMPT IS ON IT" IS ANY OVERLAP THE PROMPT WOULD WIN, not
 * a swallowed click. Those are not the same test, and the difference is the
 * whole reason this class kept getting through: Playwright hit-tests the CENTRE
 * of the box it is about to click, so a prompt lying across a control's edge and
 * stopping short of its middle dispatches cleanly and every click-based
 * assertion goes green over an overlap a user can see and can land a pointer in.
 * That is the exact state the two fill-dialog steps shipped in — 21px of popover
 * across the Add button, 9px of clearance at its centre — and the state the
 * account dialog's Cancel was in, 68px under the popover with its middle free.
 * So the rule here is the strict one `expectClearOfPopover` below already holds
 * the step's own control to, applied to every control instead of one.
 *
 * Two questions, answered by the two things that can answer them:
 *
 *   DO THEY OVERLAP AT ALL? Rectangles. Any intersection counts.
 *
 *   AND WOULD THE PROMPT WIN THERE? `elementFromPoint`, in the middle of that
 *   intersection. This is the browser's own hit test, so stacking, opacity and
 *   `pointer-events` are all accounted for without re-deriving any of them —
 *   which matters most for the coach mark, whose card is deliberately
 *   transparent to the pointer (a click goes straight through it to the control
 *   underneath, and dismisses the mark on the way) while the "Got it" and "Read
 *   more" inside it opt back in and DO catch clicks. Rectangles alone would fail
 *   the harmless case and pass the real one; the hit test tells them apart. It
 *   also means a control that is on top of the prompt — a select's dropdown, a
 *   dialog raised over it — is correctly not a hit.
 *
 * The overlap is reported in pixels, because "Got it is on top of the play
 * button" is not something the next person should have to re-derive from a
 * screenshot.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** The driver.js walkthrough popover. */
export const WALKTHROUGH_POPOVER = '.driver-popover';
/** A coach mark's card — `CoachMark.tsx` sets the attribute for exactly this. */
export const COACH_MARK = '[data-coach-mark]';

export interface ClearanceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClearanceHit {
  /** The control, named the way the person reading the failure would name it. */
  what: string;
  /** Intersection of prompt and control, in px — reported, never asserted on. */
  dx: number;
  dy: number;
  control: ClearanceRect;
  prompt: ClearanceRect;
}

/**
 * Every live control the prompt is lying across and would win a click on.
 *
 * Returns an empty list when the prompt is not on screen: a step with no prompt
 * covers nothing, and making that an error would turn every teardown assertion
 * into a race.
 */
export async function findCoveredControls(
  page: Page,
  promptSelector: string,
): Promise<ClearanceHit[]> {
  return page.evaluate((selector) => {
    const promptEl = document.querySelector(selector);
    if (promptEl === null) return [];
    const promptBox = promptEl.getBoundingClientRect();
    if (promptBox.width === 0 || promptBox.height === 0) return [];

    // Anything a user can operate. Deliberately wider than "button": the six
    // shipped instances covered a combobox, a text field, a select and three
    // buttons between them.
    //
    // A `label` that WRAPS a control is in the list because on some of these
    // forms it is the only thing a pointer can be aimed at: the account
    // dialog's risk presets are button-styled labels around `sr-only` radios,
    // so the radio is a clipped 1x1 point nobody clicks and the label is the
    // whole control as far as the user is concerned. A `label` that merely
    // points at a control with `for` is NOT — that one is a caption sitting
    // beside its field, and the field is already measured on its own account.
    const INTERACTIVE = [
      'button',
      '[role="button"]',
      'a[href]',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'label:has(> input:not([type="hidden"]))',
      '[role="combobox"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[role="radio"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[contenteditable="true"]',
    ].join(',');

    function rect(box: DOMRect) {
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }

    function describe(el: Element): string {
      const bits = [el.tagName.toLowerCase()];
      if (el.id !== '') bits.push(`#${el.id}`);
      const label =
        el.getAttribute('aria-label') ??
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48);
      const testid = el.getAttribute('data-testid');
      if (testid !== null) bits.push(`[data-testid="${testid}"]`);
      return label === '' ? bits.join('') : `${bits.join('')} "${label}"`;
    }

    const covered: ClearanceHit[] = [];
    for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
      // The prompt's own controls are the prompt.
      if (promptEl.contains(el)) continue;
      // Hidden from everyone, or explicitly inert — a modal dialog marks the
      // whole app behind it this way, and none of it is anybody's to click.
      if (el.closest('[aria-hidden="true"],[data-aria-hidden="true"],[inert]') !== null) continue;

      const style = getComputedStyle(el);
      // THE GATE. A control the page has already made unclickable is not one the
      // prompt is blocking — see the note at the top of the file.
      if (style.pointerEvents === 'none') continue;
      if (style.visibility === 'hidden' || style.display === 'none') continue;

      const box = el.getBoundingClientRect();
      // Visually hidden rather than merely small — an `sr-only` control is
      // clipped to a point, so no pointer is ever aimed at it and nothing can
      // be said to be covering it. Where one of these carries a real target it
      // is the label wrapped round it, which is measured in its own right.
      if (box.width < 4 || box.height < 4) continue;

      // DO THEY OVERLAP AT ALL — any intersection, not just a covered centre.
      const left = Math.max(promptBox.left, box.left);
      const right = Math.min(promptBox.right, box.right);
      const top = Math.max(promptBox.top, box.top);
      const bottom = Math.min(promptBox.bottom, box.bottom);
      if (right <= left || bottom <= top) continue;

      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      // Off screen: no pointer can reach it there whatever the prompt does.
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;

      // AND WOULD THE PROMPT WIN THERE — asked of the browser rather than of
      // arithmetic, in the middle of the overlap.
      const hit = document.elementFromPoint(cx, cy);
      if (hit === null || hit.closest(selector) === null) continue;

      covered.push({
        what: describe(el),
        dx: right - left,
        dy: bottom - top,
        control: rect(box),
        prompt: rect(promptBox),
      });
    }
    return covered;
  }, promptSelector);
}

function report(hits: ClearanceHit[], where: string): string {
  const lines = hits.map(
    (hit) =>
      `  • ${hit.what} — overlapped by ${hit.dx.toFixed(0)}x${hit.dy.toFixed(0)}px ` +
      `(control x ${hit.control.x.toFixed(0)}–${(hit.control.x + hit.control.width).toFixed(0)}, ` +
      `y ${hit.control.y.toFixed(0)}–${(hit.control.y + hit.control.height).toFixed(0)})`,
  );
  const prompt = hits[0]?.prompt;
  const promptLine =
    prompt === undefined
      ? ''
      : `\nprompt x ${prompt.x.toFixed(0)}–${(prompt.x + prompt.width).toFixed(0)}, ` +
        `y ${prompt.y.toFixed(0)}–${(prompt.y + prompt.height).toFixed(0)}`;
  return (
    `${where}: the prompt is standing on ${hits.length} control(s) the user can still press. ` +
    `Move it (side/align on the step, or the anchor for a coach mark) — do not narrow this ` +
    `assertion to the controls the step happens to describe.${promptLine}\n${lines.join('\n')}`
  );
}

/**
 * NOTHING THE USER CAN PRESS IS UNDER THE PROMPT. Call it at every step of every
 * set and on every coach mark; it names no control, so a control added tomorrow
 * is covered by it today.
 *
 * One round trip and one pass over the document — a few milliseconds, which is
 * why it can afford to run on every step rather than on the ones somebody
 * remembered.
 */
export async function expectPromptClearOfEveryControl(
  page: Page,
  promptSelector: string,
  where: string,
): Promise<void> {
  // `toPass` rather than a single read: a step change animates for 400ms and a
  // Radix popover positions itself after its first paint, so a bare read can
  // catch either mid-flight. It settles on the first attempt in the ordinary
  // case and costs nothing extra there.
  await expect(async () => {
    const hits = await findCoveredControls(page, promptSelector);
    expect(hits.length === 0, hits.length === 0 ? where : report(hits, where)).toBe(true);
  }).toPass({ timeout: 5_000, intervals: [100, 200, 400, 800] });
}

/**
 * THE POPOVER MUST NOT LIE ACROSS THE CONTROL ITS OWN STEP IS FINISHED BY, and
 * a click cannot always tell you that it does.
 *
 * Playwright hit-tests the CENTRE of the box it is about to click, so a popover
 * that covers a control's edge — but stops short of its middle — dispatches
 * cleanly and the suite goes green over an overlap a user can see and can land
 * a pointer in. That is exactly the state the two fill-dialog steps shipped in:
 * the popover sat 21px across the Add button's right-hand end while its centre
 * stayed 9px clear, so every real click here passed.
 *
 * Measuring the rectangles is what closes that gap, and it is why this stays
 * alongside the sweep above rather than being replaced by it: the sweep asks the
 * browser what a click at the centre would hit, which is the right question for
 * a control nobody named, while this one is deliberately stricter for the one
 * control the step is about. It fails on any intersection at all, and reports
 * the overlap in pixels so the next person does not have to re-measure it.
 */
export async function expectClearOfPopover(
  page: Page,
  control: Locator,
  what: string,
): Promise<void> {
  const pop = await page.locator(WALKTHROUGH_POPOVER).boundingBox();
  const box = await control.boundingBox();
  if (pop === null || box === null) {
    throw new Error(`${what}: the popover and the control must both be on screen to be measured`);
  }
  const dx = Math.min(pop.x + pop.width, box.x + box.width) - Math.max(pop.x, box.x);
  const dy = Math.min(pop.y + pop.height, box.y + box.height) - Math.max(pop.y, box.y);
  expect(
    dx > 0 && dy > 0,
    `the walkthrough popover overlaps ${what} by ${dx.toFixed(0)}x${dy.toFixed(0)}px ` +
      `(popover x ${pop.x.toFixed(0)}–${(pop.x + pop.width).toFixed(0)}, ` +
      `y ${pop.y.toFixed(0)}–${(pop.y + pop.height).toFixed(0)}; ` +
      `control x ${box.x.toFixed(0)}–${(box.x + box.width).toFixed(0)}, ` +
      `y ${box.y.toFixed(0)}–${(box.y + box.height).toFixed(0)})`,
  ).toBe(false);
}

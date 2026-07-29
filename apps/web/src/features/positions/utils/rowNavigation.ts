import type { MouseEvent } from 'react';

/**
 * Whether a click on a position table row should navigate to the detail page.
 *
 * Whole-row navigation is a mouse convenience layered over the symbol link —
 * that link stays the keyboard and accessibility path, so the row itself is not
 * focusable. Bail out whenever the browser is already going to do something
 * better with the click:
 *
 * - a modified or non-primary click (open in a new tab / window / background)
 * - a click that landed on a genuinely interactive element inside the row: the
 *   symbol link, or an action button, both of which handle themselves
 * - a click anywhere in the action strip (`[data-slot="row-actions"]`). Testing
 *   for an ancestor `button` is not enough: a DISABLED button emits no pointer
 *   events, so the event target becomes the tooltip's `<span>` wrapper — the
 *   button's parent, not its ancestor — and the click sails through to navigate.
 *   Matching the strip catches the wrappers and the gaps between buttons too.
 * - a click something else already handled (`preventDefault`)
 * - a click that never happened in the row's DOM subtree at all — see below
 *
 * The last case is the important one. The row renders dialogs (fill, delete
 * confirmation) and tooltips that Radix *portals* to document.body. A React
 * portal relocates the DOM node but NOT the React tree, so events raised inside
 * it still bubble to this handler as though they came from the row. Testing DOM
 * containment against `currentTarget` rejects every portalled surface at once —
 * dialogs, tooltips, toasts, select popovers — instead of chasing them
 * individually in the selector list. Without it, clicking anywhere non-
 * interactive inside an open dialog navigates away from it.
 *
 * Shared by the positions list and the dashboard open-positions widget.
 */
export function shouldNavigateFromRowClick(e: MouseEvent<HTMLElement>): boolean {
  if (e.defaultPrevented) return false;
  if (e.button !== 0) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const target = e.target as HTMLElement;
  if (!e.currentTarget.contains(target)) return false;
  return !target.closest('a, button, input, [role="menuitem"], [data-slot="row-actions"]');
}

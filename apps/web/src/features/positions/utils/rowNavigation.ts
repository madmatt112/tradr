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
 *   symbol link, or the actions menu trigger, both of which handle themselves
 * - a click something else already handled (`preventDefault`)
 *
 * Shared by the positions list and the dashboard open-positions widget.
 */
export function shouldNavigateFromRowClick(e: MouseEvent<HTMLElement>): boolean {
  if (e.defaultPrevented) return false;
  if (e.button !== 0) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return !(e.target as HTMLElement).closest('a, button, input, [role="menuitem"]');
}

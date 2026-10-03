import { type Page } from '@playwright/test';

/**
 * Below the md breakpoint (768px) the desk rail is `max-md:hidden` and the only
 * route to the nav destinations is the MobileNav overlay (design C5). Specs that
 * click or assert a sidebar link/button call this first so those destinations
 * are reachable on the Mobile Chrome project; on a desktop viewport the rail is
 * already present, so this is a no-op.
 *
 * The "Open navigation" button lives in a `md:hidden` header, so it is visible
 * at exactly the widths where the rail is hidden. We branch off the configured
 * viewport rather than a snapshot `isVisible()` check so the open is race-free
 * right after a navigation (the click auto-waits for the button to mount).
 *
 * Returns whether the overlay was opened, so a caller whose next step needs the
 * bare page can close it with Escape.
 */
export async function openMobileNavIfPresent(page: Page): Promise<boolean> {
  const width = page.viewportSize()?.width ?? Infinity;
  if (width >= 768) return false;
  await page.getByRole('button', { name: 'Open navigation' }).click();
  return true;
}

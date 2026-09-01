// Feedback slice geometry — the paired tab-width and <main>-gutter class
// constants REQ-2.2 demands cannot drift.
//
// The `44` in `w-11` (44px), `pr-[44px]` and `pr-[404px]` (360 + 44) is ONE
// decision, kept on adjacent lines so the tab and the gutter stay in lockstep.
//
// The coarse gutter is written `pr-[44px]` (arbitrary value), never the
// off-ladder integer shorthand: `check-design-lint.mjs`'s SPACING-LADDER check
// flags off-ladder integer spacing utilities (44px is not a ladder step) in
// every non-`components/ui` source file — `geometry.ts` is in scope — and would
// red CI on the shorthand, while arbitrary `[Npx]` values are explicitly
// outside the ladder's scope (the `_auth.tsx` `lg:pr-[384px]` precedent). Width
// utilities (`w-6` / `w-11`) are not in the gate's spacing group.
export const FEEDBACK_TAB_WIDTH_CLASSES = 'w-6 pointer-coarse:w-11';
export const FEEDBACK_MAIN_GUTTER = 'pointer-coarse:pr-[44px]';
export const FEEDBACK_MAIN_GUTTER_DRAWER_OPEN = 'pointer-coarse:lg:pr-[404px]';

// The anonymity-copy link target — an alternative channel for feedback that
// needs a reply (the form itself is anonymous and cannot).
export const FEEDBACK_ISSUES_URL = 'https://github.com/madmatt112/tradr/issues';

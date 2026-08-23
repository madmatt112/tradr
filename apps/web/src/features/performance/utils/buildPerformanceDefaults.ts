import { derivePresetRange } from './derivePresetRange';

// Default search params for the Performance route: the `monthly` preset (12m
// window) anchored at the user's STORED reporting timezone. Lived in the
// Sidebar while the nav link had to seed a complete search; the route now
// derives its own defaults at the boundary (visual-redesign 2.4), so this is
// performance-feature code.
//
// `tz` is a parameter rather than something this function derives: it comes
// from `useUserTimezone()`, and a hook cannot be read from module scope. The
// caller reads it inside a component and passes it down.
export function buildPerformanceDefaults(tz: string): {
  granularity: 'day' | 'week' | 'month' | 'year';
  start: string;
  end: string;
  tz: string;
} {
  const range = derivePresetRange(
    'monthly',
    { earliestClosedAt: null, mostRecentClosedAt: null, totalClosedPositions: 0 },
    new Date(),
    tz,
    0,
  );
  return { granularity: range.granularity, start: range.start, end: range.end, tz };
}

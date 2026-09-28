// One deep link per Statistics-panel figure, into the Methodology page
// (Component 2, D4). The anchors are the heading ids the docs build derives
// from the glossary's own headings via `github-slugger`; `statAnchors.test.ts`
// checks this map against those slugs so a heading rename is caught (2.4).
//
// The map is keyed by `PerformanceStats` fields (minus the two booleans that
// have no row). The host is not written here — `statDocsUrl` composes the URL
// through `docsUrl`, so `docs.ts` stays the one place the host appears (2.3).
import type { PerformanceStats } from '@tradr/shared';

import { docsUrl } from '@/lib/docs';

/** The `PerformanceStats` fields that render as a Statistics-panel row. */
export type StatField = Exclude<keyof PerformanceStats, 'hasWins' | 'hasLosses'>;

/** Field → Methodology-page heading anchor (no leading `#`). */
export const STAT_ANCHORS: Record<StatField, string> = {
  totalPositions: 'total-positions',
  totalNetPnl: 'total-net-pl',
  winRate: 'win-rate',
  breakevenRate: 'breakeven-rate',
  avgWin: 'average-win--average-loss',
  avgLoss: 'average-win--average-loss',
  profitFactor: 'profit-factor',
  expectancy: 'expectancy',
  largestWin: 'largest-win--largest-loss',
  largestLoss: 'largest-win--largest-loss',
};

/** Absolute URL to the Methodology heading that defines `field`. */
export function statDocsUrl(field: StatField): string {
  return `${docsUrl('metricsGlossary')}#${STAT_ANCHORS[field]}`;
}

// The compliance-rate figure on the performance page's Compliance panel (C11)
// is not a `PerformanceStats` field, so it sits outside `STAT_ANCHORS`, but its
// label deep-links to the glossary the same way. The anchor is the id the docs
// build derives from the "Compliance rate" heading; `statAnchors.test.ts` checks
// it against the page's slugs alongside `STAT_ANCHORS`.
export const COMPLIANCE_RATE_ANCHOR = 'compliance-rate';

/** Absolute URL to the Methodology heading that defines the compliance rate. */
export function complianceRateDocsUrl(): string {
  return `${docsUrl('metricsGlossary')}#${COMPLIANCE_RATE_ANCHOR}`;
}

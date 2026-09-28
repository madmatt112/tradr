import type { ComplianceEntry, PositionCompliance, RuleWeight } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EM_DASH } from '@/lib/format';

const WEIGHT_LABELS: Record<RuleWeight, string> = {
  critical: 'Critical',
  important: 'Important',
  nice_to_have: 'Nice to have',
};

const WEIGHT_BADGE: Record<RuleWeight, 'destructive' | 'default' | 'secondary'> = {
  critical: 'destructive',
  important: 'default',
  nice_to_have: 'secondary',
};

// Why a rule could not be evaluated, in words (Requirement 6.2). The API sends a
// reason token; the card only formats it.
const REASON_LABELS: Record<NonNullable<ComplianceEntry['reason']>, string> = {
  no_stop_loss: 'No stop loss set',
  no_target_price: 'No target price set',
  no_planned_rr: 'No planned R:R',
  non_positive_balance: 'Account balance not positive',
};

// A measured value or limit, rendered per its unit. Numbers go through `Numeric`;
// currency units carry the entry's currency; list units are plain text tokens
// (design C10). `direction="none"` keeps it a neutral figure — no gain/loss sign.
function Measure({
  value,
  unit,
  currency,
}: {
  value: string;
  unit: ComplianceEntry['unit'];
  currency: string | null;
}) {
  switch (unit) {
    case 'currency':
      return <Numeric value={value} kind="money" currency={currency ?? 'USD'} direction="none" />;
    case 'percent':
      return <Numeric value={value} kind="percent" direction="none" />;
    case 'ratio':
      return <Numeric value={value} kind="decimal" direction="none" />;
    case 'count':
      return <Numeric value={value} kind="integer" direction="none" />;
    case 'minutes':
      return (
        <span>
          <Numeric value={value} kind="integer" direction="none" /> min
        </span>
      );
    case 'list':
      return <span>{value.split(',').join(', ').replace(/_/g, ' ')}</span>;
  }
}

/**
 * The compliance card on the position detail (design C10; Requirement 6.2-6.4).
 * Shows the score with a provisional/final badge, each breach (description,
 * measured against limit, weight) and each not-evaluable rule with its reason.
 * With no entries it says no rule applies and shows no score (Requirement 6.3).
 *
 * It formats only — the API computes every outcome and the score (Requirement
 * 6.4). Passes are not listed (D18).
 */
export function ComplianceCard({ compliance }: { compliance: PositionCompliance }) {
  const hasEntries = compliance.entries.length > 0;
  const breaches = compliance.entries.filter((e) => e.outcome === 'breach');
  const notEvaluable = compliance.entries.filter((e) => e.outcome === 'not_evaluable');

  const finalityLabel =
    compliance.finality === 'final'
      ? 'Final'
      : compliance.finality === 'provisional'
        ? 'Provisional'
        : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-muted-foreground">Compliance</CardTitle>
        {hasEntries && (
          <CardAction className="flex items-center gap-2">
            <span className="text-2xl font-bold">{compliance.score ?? EM_DASH}</span>
            {finalityLabel && (
              <Badge variant={compliance.finality === 'final' ? 'default' : 'secondary'}>
                {finalityLabel}
              </Badge>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasEntries ? (
          <p className="text-sm text-muted-foreground">No rule applies to this position</p>
        ) : (
          <>
            {breaches.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-destructive">Breaches</h3>
                <ul className="divide-y divide-hairline rounded-md border">
                  {breaches.map((entry) => (
                    <li key={entry.ruleId} className="flex flex-col gap-1 px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm">{entry.description}</span>
                        <Badge variant={WEIGHT_BADGE[entry.weight]}>
                          {WEIGHT_LABELS[entry.weight]}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        <Measure
                          value={entry.measured ?? EM_DASH}
                          unit={entry.unit}
                          currency={entry.currency}
                        />{' '}
                        against{' '}
                        <Measure value={entry.limit} unit={entry.unit} currency={entry.currency} />
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No breaches</p>
            )}

            {notEvaluable.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Not evaluable</h3>
                <ul className="divide-y divide-hairline rounded-md border">
                  {notEvaluable.map((entry) => (
                    <li
                      key={entry.ruleId}
                      className="flex items-start justify-between gap-2 px-3 py-2"
                    >
                      <span className="text-sm">{entry.description}</span>
                      <span className="text-sm text-muted-foreground">
                        {entry.reason ? REASON_LABELS[entry.reason] : 'Not evaluable'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

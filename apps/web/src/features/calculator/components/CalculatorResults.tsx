import type { ReactNode } from 'react';

import type { CalculatorOutput } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  result: CalculatorOutput | null;
  error?: string | null;
  brokerageHint?: string;
  /** ISO-4217 code for the money figures. Defaults to USD (dollar-basis mode). */
  currency?: string;
  /** Balance the derived risk was computed from — supplies the basis annotation. */
  balance?: string;
  /** Risk percent the derived risk was computed from — supplies the basis annotation. */
  riskPercent?: string;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

/**
 * Neutral money figure for the sizing/fee surfaces — these are price/value
 * figures (cost basis, position value, fees), not gain/loss, so they use
 * `direction="none"` (no spurious gain/loss color). Output strings are 2dp
 * (`to2dp`) so the primitive's money default precision is behavior-preserving.
 * `currency` defaults to USD (dollar-basis mode) and is the selected account's
 * currency in percent mode — the figure is displayed as-is, no conversion (REQ-5.1).
 */
function Money({ value, currency }: { value: string; currency: string }) {
  return <Numeric value={value} kind="money" currency={currency} direction="none" />;
}

/**
 * Human-readable message for a zero-position outcome, keyed on the machine
 * discriminator. Absent status ⇒ the pre-existing insufficient-risk message
 * (unchanged — the dollar-basis / insufficient-in-percent case).
 */
function nonSizingMessage(status: CalculatorOutput['sizingStatus']): string {
  switch (status) {
    case 'nothing-to-size-against':
      return 'The account balance is zero or negative — there is nothing to size against.';
    case 'exceeds-maximum':
      return "The derived dollar risk exceeds the calculator's maximum.";
    case 'buying-power-zero':
      // Deliberately says "buying power", not "balance": under the default
      // preference the cap is the account's CASH, so an account with a healthy
      // balance but everything already deployed lands here. Blaming the balance
      // would read as a bug.
      return 'Available buying power cannot fund one share/contract at this entry price.';
    default:
      return 'Dollar risk is insufficient for one share/contract at this stop distance';
  }
}

export function CalculatorResults({
  result,
  error,
  brokerageHint,
  currency = 'USD',
  balance,
  riskPercent,
}: Props) {
  const isZeroPosition = result !== null && result.positionSize === 0;
  const hasRiskReward =
    result !== null && result.riskRewardRatio !== undefined && result.perUnitReward !== undefined;
  const hasFees = result !== null && result.estimatedFees !== undefined;
  const hasAdjustedRR = result !== null && result.adjustedRiskRewardRatio !== undefined;

  return (
    // `data-tour` is the walkthrough's anchor for the output panel and carries
    // no behaviour.
    <div
      aria-live="polite"
      aria-atomic="true"
      data-tour="calculator-results"
      className="min-h-[28rem] space-y-4"
    >
      {currency !== 'USD' && (
        <p className="text-sm text-muted-foreground">
          Balance is in {currency}; figures shown in {currency}, no conversion applied.
        </p>
      )}

      {/* Derived-risk row — hoisted above the error/null/zero/sized split so it
          renders alongside both the sizing card and any zero-position message
          (REQ-4.1). Scoped to `derivedDollarRisk` present: the pure function only
          echoes it in percent mode with balance > 0. */}
      {result !== null && result.derivedDollarRisk !== undefined && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Derived Dollar Risk</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Risk basis</span>
              <span className="font-medium">
                <Money value={result.derivedDollarRisk} currency={currency} />
                {balance !== undefined && riskPercent !== undefined && (
                  <span className="font-normal text-muted-foreground">
                    {' · '}
                    {riskPercent}% of <Money value={balance} currency={currency} />
                  </span>
                )}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {error ? (
        <Card>
          <CardContent className="flex min-h-[24rem] items-center justify-center py-12">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      ) : result === null ? (
        <Card>
          <CardContent className="flex min-h-[24rem] items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">
              {brokerageHint ?? 'Enter trade parameters to see results'}
            </p>
          </CardContent>
        </Card>
      ) : isZeroPosition ? (
        <Card>
          <CardContent className="flex min-h-[24rem] items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{nonSizingMessage(result.sizingStatus)}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {brokerageHint && (
            <Card>
              <CardContent className="py-3">
                <p className="text-sm text-muted-foreground">{brokerageHint}</p>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Position Sizing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Row
                label="Position size"
                value={<Numeric value={result.positionSize} kind="integer" direction="none" />}
              />
              <Row
                label="Per-unit risk"
                value={<Money value={result.perUnitRisk} currency={currency} />}
              />
              <Row
                label="Actual dollar risk"
                value={<Money value={result.actualDollarRisk} currency={currency} />}
              />
              <Row
                label="Total position value"
                value={<Money value={result.totalPositionValue} currency={currency} />}
              />
              {result.buyingPowerLimited === true && (
                <div className="flex items-center gap-2 pt-1 text-sm">
                  <Badge variant="secondary">Buying power</Badge>
                  <span className="text-muted-foreground">
                    Position size limited by account buying power
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {hasRiskReward && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Risk / Reward</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Row
                  label="Per-unit reward"
                  value={<Money value={result.perUnitReward!} currency={currency} />}
                />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Risk/Reward ratio</span>
                  <Badge variant="secondary">
                    1:
                    <Numeric value={result.riskRewardRatio!} kind="decimal" direction="none" />
                  </Badge>
                </div>
              </CardContent>
            </Card>
          )}

          {hasFees && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Fee Impact</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Row
                  label="Estimated fees"
                  value={<Money value={result.estimatedFees!} currency={currency} />}
                />
                <Row
                  label="Fee-to-risk %"
                  value={
                    <Numeric value={result.feeToRiskPercent!} kind="percent" direction="none" />
                  }
                />
                <Row
                  label="Adjusted dollar risk"
                  value={<Money value={result.adjustedDollarRisk!} currency={currency} />}
                />
                <Row
                  label="Breakeven"
                  value={<Money value={result.breakeven!} currency={currency} />}
                />
              </CardContent>
            </Card>
          )}

          {hasAdjustedRR && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Adjusted Risk / Reward</CardTitle>
              </CardHeader>
              <CardContent>
                {result.adjustedRiskRewardRatio!.startsWith('-') ? (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">After fees</span>
                    {/* Net-loss ratio: the leading `-` is load-bearing status text
                        and the figure is wrapped in `text-destructive`, so it is
                        rendered verbatim (not via the neutral primitive, which
                        would strip the sign). */}
                    <span className="font-medium text-destructive">
                      {result.adjustedRiskRewardRatio} (net loss at target)
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">After fees</span>
                    <Badge variant="secondary">
                      1:
                      <Numeric
                        value={result.adjustedRiskRewardRatio!}
                        kind="decimal"
                        direction="none"
                      />
                    </Badge>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

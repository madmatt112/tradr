import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';

import { blackScholes, type BlackScholesInput, type BlackScholesOutput } from '@tradr/shared';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { formToWireInput, type FormStringState } from '../lib/formToWireInput';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365;

/** Browser-local YYYY-MM-DD string (REQ-7.6). */
function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local YYYY-MM-DD `days` calendar days from today. */
function isoPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Convert a YYYY-MM-DD picked date → T years from today (browser local). */
function computeTFromDate(iso: string): number {
  const [y, m, d] = iso.split('-').map((s) => Number(s));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  const picked = new Date(y, m - 1, d).getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((picked - today.getTime()) / MS_PER_DAY);
  return diffDays / DAYS_PER_YEAR;
}

const DEFAULT_EXPIRY_ISO = isoPlusDays(30);
const DEFAULT_T_FROM_30_DAYS = 30 / DAYS_PER_YEAR;

// ---------------------------------------------------------------------------
// Props (REQ-7.10 verbatim)
// ---------------------------------------------------------------------------

export interface BlackScholesCardProps {
  initialInputs?: Partial<BlackScholesInput>;
  density?: 'comfortable' | 'compact';
  hideDateHelper?: boolean;
  onCompute?: (output: BlackScholesOutput) => void;
  onInputChange?: (snapshot: Partial<BlackScholesInput>) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BlackScholesCard({
  initialInputs,
  density = 'comfortable',
  hideDateHelper = false,
  onCompute,
  onInputChange,
}: BlackScholesCardProps) {
  const form = useForm<FormStringState>({
    mode: 'onChange',
    reValidateMode: 'onChange',
    defaultValues: {
      S: initialInputs?.S?.toString() ?? '',
      K: initialInputs?.K?.toString() ?? '',
      T: (initialInputs?.T ?? DEFAULT_T_FROM_30_DAYS).toString(),
      sigma: (initialInputs?.sigma ?? 0.3).toString(),
      r: (initialInputs?.r ?? 0.044).toString(),
      q: (initialInputs?.q ?? 0.0).toString(),
      type: initialInputs?.type ?? 'call',
    },
  });

  const { register, setValue, watch } = form;
  const { dirtyFields } = form.formState;

  const formValues = watch();
  const conversion = formToWireInput(formValues);

  // dirtyFields gate (sub-step c)
  function fieldErrorMessage(field: keyof FormStringState): string | undefined {
    if (!dirtyFields[field]) return undefined;
    if (!conversion.ok) return conversion.fieldErrors[field];
    return undefined;
  }

  // Output (sub-step d): null when conversion fails — placeholder shown
  const output: BlackScholesOutput | null = conversion.ok ? blackScholes(conversion.value) : null;

  // T-input UX guard (sub-step f)
  const tNum = Number(formValues.T);
  const showTGuard = Number.isFinite(tNum) && tNum >= 5;

  // T-vs-date helper picked date — derived from current T
  const helperDateIso = useMemo(() => {
    const t = Number(formValues.T);
    if (!Number.isFinite(t)) return DEFAULT_EXPIRY_ISO;
    const days = Math.round(t * DAYS_PER_YEAR);
    return isoPlusDays(days);
  }, [formValues.T]);

  function handleDatePicked(newDate: string) {
    const newT = computeTFromDate(newDate);
    setValue('T', newT.toString(), { shouldValidate: true, shouldDirty: true });
  }

  // Snapshot for onInputChange (sub-step h)
  // Snapshot field order follows BlackScholesInputSchema: S, K, T, sigma, r, q, type
  const snapshot: Partial<BlackScholesInput> = useMemo(() => {
    const partial: Partial<BlackScholesInput> = {};
    const parse = (v: string) => {
      const n = Number(v);
      return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
    };
    const S = parse(formValues.S);
    const K = parse(formValues.K);
    const T = parse(formValues.T);
    const sigma = parse(formValues.sigma);
    const r = parse(formValues.r);
    const q = parse(formValues.q);
    if (S !== undefined) partial.S = S;
    if (K !== undefined) partial.K = K;
    if (T !== undefined) partial.T = T;
    if (sigma !== undefined) partial.sigma = sigma;
    if (r !== undefined) partial.r = r;
    if (q !== undefined) partial.q = q;
    partial.type = formValues.type;
    return partial;
  }, [
    formValues.S,
    formValues.K,
    formValues.T,
    formValues.sigma,
    formValues.r,
    formValues.q,
    formValues.type,
  ]);

  // Dedupe key uses BlackScholesOutputSchema field order — do not reorder.
  const outputKey = output
    ? JSON.stringify({
        price: output.price,
        delta: output.delta,
        gamma: output.gamma,
        thetaPerDay: output.thetaPerDay,
        vegaPerPct: output.vegaPerPct,
        rhoPerPct: output.rhoPerPct,
      })
    : null;

  useEffect(() => {
    if (output && onCompute) onCompute(output);
  }, [outputKey]);

  const snapshotKey = JSON.stringify(snapshot);
  useEffect(() => {
    if (onInputChange) onInputChange(snapshot);
  }, [snapshotKey]);

  // Layout switches (sub-step g)
  const isComfortable = density === 'comfortable';
  const showDateHelper = isComfortable && !hideDateHelper;
  const gridClass = isComfortable
    ? 'grid grid-cols-1 gap-4 md:grid-cols-2'
    : 'grid grid-cols-1 gap-3';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Black-Scholes Pricer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
          <div className="space-y-2">
            <Label htmlFor="bs-type">Type</Label>
            <Tabs
              value={formValues.type}
              onValueChange={(v) =>
                setValue('type', v as 'call' | 'put', { shouldValidate: true, shouldDirty: true })
              }
            >
              <TabsList>
                <TabsTrigger value="call" className="cursor-pointer">
                  Call
                </TabsTrigger>
                <TabsTrigger value="put" className="cursor-pointer">
                  Put
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className={gridClass}>
            <div className="space-y-2">
              <Label htmlFor="bs-S">Spot price (S)</Label>
              <Input
                id="bs-S"
                type="text"
                inputMode="decimal"
                placeholder="100.00"
                {...register('S')}
              />
              {fieldErrorMessage('S') && (
                <p className="text-sm text-destructive">{fieldErrorMessage('S')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bs-K">Strike price (K)</Label>
              <Input
                id="bs-K"
                type="text"
                inputMode="decimal"
                placeholder="100.00"
                {...register('K')}
              />
              {fieldErrorMessage('K') && (
                <p className="text-sm text-destructive">{fieldErrorMessage('K')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bs-T">Time to expiry (T, years)</Label>
              <Input
                id="bs-T"
                type="text"
                inputMode="decimal"
                placeholder="0.0822"
                {...register('T')}
              />
              {fieldErrorMessage('T') && (
                <p className="text-sm text-destructive">{fieldErrorMessage('T')}</p>
              )}
              {showTGuard && (
                <Alert>
                  <AlertDescription>
                    T is in years — did you mean a fractional value? (e.g. 30 days ≈ 0.0822)
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bs-sigma">Volatility (σ)</Label>
              <Input
                id="bs-sigma"
                type="text"
                inputMode="decimal"
                placeholder="0.30"
                {...register('sigma')}
              />
              {fieldErrorMessage('sigma') && (
                <p className="text-sm text-destructive">{fieldErrorMessage('sigma')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bs-r">Risk-free rate (r)</Label>
              <Input
                id="bs-r"
                type="text"
                inputMode="decimal"
                placeholder="0.0440"
                {...register('r')}
              />
              {fieldErrorMessage('r') && (
                <p className="text-sm text-destructive">{fieldErrorMessage('r')}</p>
              )}
              {isComfortable && (
                <p className="text-xs text-muted-foreground">
                  Continuously-compounded rate. r = 0.0440 ≈ 4.5% annual yield.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bs-q">Dividend yield (q)</Label>
              <Input
                id="bs-q"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                {...register('q')}
              />
              {fieldErrorMessage('q') && (
                <p className="text-sm text-destructive">{fieldErrorMessage('q')}</p>
              )}
            </div>
          </div>

          {showDateHelper && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">T vs date helper</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="space-y-2">
                  <Label htmlFor="bs-expiry-date">Pick expiry date</Label>
                  <Input
                    id="bs-expiry-date"
                    type="date"
                    value={helperDateIso}
                    onChange={(e) => handleDatePicked(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {todayLocalIso()} (your local date)
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => handleDatePicked(isoPlusDays(7))}
                  >
                    +7d
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => handleDatePicked(isoPlusDays(30))}
                  >
                    +30d
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => handleDatePicked(isoPlusDays(90))}
                  >
                    +90d
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </form>

        <Separator />

        {/* Result panel (sub-step d) */}
        <div aria-live="polite" aria-atomic="true">
          {output === null ? (
            <p className="text-sm text-muted-foreground">
              Enter spot, strike, T, σ, r to see prices and Greeks.
            </p>
          ) : (
            <div className="space-y-2">
              {/* output.* are already raw format6SigFig strings (REQ-7.11) — render directly. */}
              <ResultRow label="Price" value={output.price} />
              <ResultRow label="Delta (Δ)" value={output.delta} />
              <ResultRow label="Gamma (Γ)" value={output.gamma} />
              <ResultRow label="Theta / day (Θ)" value={output.thetaPerDay} />
              <ResultRow label="Vega / 1% (ν)" value={output.vegaPerPct} />
              <ResultRow label="Rho / 1% (ρ)" value={output.rhoPerPct} />
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Informational only. Black-Scholes assumes European-style options, constant volatility, and
          no early exercise — actual market prices may differ. Not investment advice.
        </p>
      </CardContent>
    </Card>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  // `value` is a pre-formatted `format6SigFig` string (REQ-7.11). It is NOT
  // re-formatted through the Numeric primitive — re-parsing would drop the
  // 6-sig-fig precision the shared formatter produced (R5.2: Greeks stay on
  // format6SigFig, no duplication). Rendered verbatim, right-aligned by the
  // flex row.
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

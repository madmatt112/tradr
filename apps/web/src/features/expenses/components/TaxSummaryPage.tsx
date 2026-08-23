import { ChevronDown, Loader2, Receipt } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';

import {
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
} from '@tradr/shared/constants/expense-categories';
import type { TaxJurisdiction } from '@tradr/shared/schemas/expense';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useMissingRatePrompt } from '@/features/accounting/hooks/useMissingRatePrompt';
import { WashSaleFlagsTable } from '@/features/expenses/components/WashSaleFlagsTable';
import {
  useTaxJurisdictionMutation,
  useTaxJurisdictionQuery,
} from '@/features/expenses/hooks/useTaxJurisdiction';
import { useTaxSummary } from '@/features/expenses/hooks/useTaxSummary';
import { formatCurrency } from '@/lib/format';

const JURISDICTION_LABELS: Record<TaxJurisdiction, string> = {
  US: 'United States',
  CA: 'Canada',
  other: 'Other',
};

function buildYearOptions(currentYear: number): number[] {
  const years: number[] = [];
  for (let y = currentYear; y >= currentYear - 5; y -= 1) {
    years.push(y);
  }
  return years;
}

/**
 * Render the server-supplied disclaimer string with a one-shot substitution
 * for markdown-style links (e.g. `[Fee Rollup](/accounting/fee-rollup)`).
 * Matches FeeRollupPage's `DisclaimerBody` helper so the rendering is
 * consistent across the two pages. Multi-paragraph text (the v1 disclaimer
 * is 7 paragraphs) is split on blank lines.
 */
function DisclaimerBody({ text }: { text: string }) {
  const paragraphs = text.split(/\n\s*\n/);
  const linkRegex = /\[([^\]]+)\]\((\/[^)]+)\)/g;

  return (
    <div className="space-y-3">
      {paragraphs.map((para, pIdx) => {
        const segments: Array<
          { kind: 'text'; value: string } | { kind: 'link'; label: string; href: string }
        > = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        linkRegex.lastIndex = 0;
        while ((match = linkRegex.exec(para)) !== null) {
          if (match.index > lastIndex) {
            segments.push({ kind: 'text', value: para.slice(lastIndex, match.index) });
          }
          segments.push({ kind: 'link', label: match[1], href: match[2] });
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < para.length) {
          segments.push({ kind: 'text', value: para.slice(lastIndex) });
        }
        return (
          <p key={pIdx} className="text-sm leading-relaxed">
            {segments.map((seg, i) => {
              if (seg.kind === 'text') {
                return <Fragment key={i}>{seg.value}</Fragment>;
              }
              return (
                <a
                  key={i}
                  href={seg.href}
                  className="cursor-pointer text-primary underline-offset-4 hover:underline"
                >
                  {seg.label}
                </a>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

export function TaxSummaryPage() {
  const currentYear = new Date().getUTCFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const yearOptions = useMemo(() => buildYearOptions(currentYear), [currentYear]);

  const { data: jurisdictionData } = useTaxJurisdictionQuery();
  const jurisdictionMutation = useTaxJurisdictionMutation();
  const { data, isLoading, isError } = useTaxSummary(selectedYear);

  // The dropdown's controlled value tracks the server-confirmed jurisdiction
  // (post-review fix #10) — never local state. On a failed PATCH, the cache
  // stays on the prior value so the dropdown reverts automatically. A NULL
  // stored jurisdiction defaults to 'other' (Req: "default 'Other' when NULL"),
  // matching the value the tax-summary endpoint materializes NULL into — so the
  // dropdown and the computed summary agree for a not-yet-chosen jurisdiction.
  const dropdownValue = jurisdictionData?.taxJurisdiction ?? 'other';

  const { deeplinkTo } = useMissingRatePrompt();

  const jurisdiction = data?.jurisdiction ?? dropdownValue;
  const displayCurrency = data?.displayCurrency ?? null;

  const isEmpty =
    data !== undefined &&
    (data.realisedPnl.total === null || parseFloat(data.realisedPnl.total) === 0) &&
    (data.trackedExpenses.total === null || parseFloat(data.trackedExpenses.total) === 0);

  const showFlags = jurisdiction !== 'other';
  const showShortLong = jurisdiction === 'US';

  return (
    <div className="space-y-6">
      <div>
        <PageHeader page="Tax Summary" className="mb-2" />
        <p className="text-sm text-muted-foreground">
          Realised P&amp;L, tracked expenses, and flagged positions for the selected year.
        </p>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="tax-summary-year" className="text-xs text-muted-foreground">
              Year
            </label>
            <Select
              value={String(selectedYear)}
              onValueChange={(val) => setSelectedYear(Number(val))}
            >
              <SelectTrigger id="tax-summary-year" className="w-32 cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="tax-summary-jurisdiction" className="text-xs text-muted-foreground">
              Jurisdiction
            </label>
            <div className="flex items-center gap-2">
              <Select
                value={dropdownValue}
                onValueChange={(val) => {
                  jurisdictionMutation.mutate(val as TaxJurisdiction);
                }}
                disabled={jurisdictionMutation.isPending}
              >
                <SelectTrigger id="tax-summary-jurisdiction" className="w-40 cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(JURISDICTION_LABELS) as TaxJurisdiction[]).map((j) => (
                    <SelectItem key={j} value={j}>
                      {JURISDICTION_LABELS[j]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {jurisdictionMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Disclaimer banner — defaults to OPEN per post-v3-fix #4. Local
          component state (not persisted) so every reload re-expands it. */}
      {data && (
        <div className="rounded-md border border-warning/30 bg-warning/10 text-foreground">
          <Accordion type="single" collapsible defaultValue="disclaimer" className="px-4">
            <AccordionItem value="disclaimer" className="border-b-0">
              <AccordionTrigger className="text-warning">
                Disclaimer — please read before using these figures
              </AccordionTrigger>
              <AccordionContent>
                <DisclaimerBody text={data.disclaimer} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}

      {data && data.missingRates.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-foreground">
          <span className="font-medium text-warning">Missing exchange rate(s):</span>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {data.missingRates.map((p) => (
              <li key={`${p.base}-${p.quote}`}>
                {p.base} → {p.quote}
              </li>
            ))}
          </ul>
          {deeplinkTo && (
            <a
              href={deeplinkTo}
              className="cursor-pointer text-primary underline-offset-4 hover:underline"
            >
              Enter rate
            </a>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <div className="py-8 text-center text-sm text-destructive">
          Failed to load tax summary. Please try again.
        </div>
      ) : !data ? null : isEmpty ? (
        <EmptyState
          icon={<Receipt className="h-10 w-10" />}
          title={`No realised P&L or tracked expenses for ${selectedYear}`}
          description="Close positions or record expenses to see them aggregated here."
        />
      ) : (
        <>
          {(data.ratesAsOf || data.excludedCurrencies.length > 0) && (
            <div className="rounded-md border p-3 text-xs text-muted-foreground">
              {data.ratesAsOf && <span>Rates as of {data.ratesAsOf}. </span>}
              {data.excludedCurrencies.length > 0 && (
                <span>Excluded (missing rate): {data.excludedCurrencies.join(', ')}.</span>
              )}
            </div>
          )}

          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Realised P&amp;L</h2>
              {data.realisedPnl.total !== null && (
                <span className="text-xl font-bold">
                  {displayCurrency
                    ? formatCurrency(parseFloat(data.realisedPnl.total), displayCurrency)
                    : data.realisedPnl.total}
                </span>
              )}
            </div>

            {data.realisedPnl.perCurrency.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium text-muted-foreground">Per currency</h3>
                <div className="flex flex-wrap gap-4 rounded-md border p-3">
                  {data.realisedPnl.perCurrency.map((row) => (
                    <div key={row.currency} className="text-sm">
                      <span className="font-medium">
                        {formatCurrency(parseFloat(row.amount), row.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {showShortLong && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Short-term</div>
                  <div className="mt-1 text-base font-medium">
                    {data.realisedPnl.shortTerm !== null && displayCurrency
                      ? formatCurrency(parseFloat(data.realisedPnl.shortTerm), displayCurrency)
                      : (data.realisedPnl.shortTerm ?? '—')}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Long-term</div>
                  <div className="mt-1 text-base font-medium">
                    {data.realisedPnl.longTerm !== null && displayCurrency
                      ? formatCurrency(parseFloat(data.realisedPnl.longTerm), displayCurrency)
                      : (data.realisedPnl.longTerm ?? '—')}
                  </div>
                </div>
              </div>
            )}
          </section>

          <Separator />

          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Tracked Expenses</h2>
              {data.trackedExpenses.total !== null && (
                <span className="text-xl font-bold">
                  {displayCurrency
                    ? formatCurrency(parseFloat(data.trackedExpenses.total), displayCurrency)
                    : data.trackedExpenses.total}
                </span>
              )}
            </div>

            {data.trackedExpenses.perCategory.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium text-muted-foreground">Per category</h3>
                <div className="rounded-md border p-3">
                  <ul className="space-y-1 text-sm">
                    {data.trackedExpenses.perCategory.map((row, i) => (
                      <li
                        key={`${row.category}-${row.currency}-${i}`}
                        className="flex justify-between gap-3"
                      >
                        <span>{EXPENSE_CATEGORY_LABELS[row.category as ExpenseCategory]}</span>
                        <span className="font-medium">
                          {formatCurrency(parseFloat(row.total), row.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>

          {/* Wash-sale / superficial-loss collapsibles — omitted entirely
              when jurisdiction === 'other' per Req 4.4. */}
          {showFlags && data.flags.washSales.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between rounded-md border p-3 text-left text-sm font-medium hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180">
                <span>Wash sales ({data.flags.washSales.length})</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <WashSaleFlagsTable
                  flags={data.flags.washSales}
                  kind="washSale"
                  displayCurrency={displayCurrency}
                />
              </CollapsibleContent>
            </Collapsible>
          )}

          {showFlags && data.flags.superficialLosses.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between rounded-md border p-3 text-left text-sm font-medium hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180">
                <span>Superficial losses ({data.flags.superficialLosses.length})</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <WashSaleFlagsTable
                  flags={data.flags.superficialLosses}
                  kind="superficialLoss"
                  displayCurrency={displayCurrency}
                />
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
    </div>
  );
}

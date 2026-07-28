import { Link } from '@tanstack/react-router';
import { ReceiptText } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useMissingRatePrompt } from '@/features/accounting/hooks/useMissingRatePrompt';
import { useFeeRollup } from '@/features/expenses/hooks/useFeeRollup';
import { formatCurrency } from '@/lib/format';

const TAX_SUMMARY_PATH = '/accounting/tax-summary';

function buildYearOptions(currentYear: number): number[] {
  const years: number[] = [];
  for (let y = currentYear; y >= currentYear - 5; y -= 1) {
    years.push(y);
  }
  return years;
}

/**
 * Renders the server-supplied disclaimer string. The disclaimer is a plain
 * string (not Zod-validated as markdown), but the response is expected to
 * contain a single markdown link `[Tax Summary page](/accounting/tax-summary)`.
 * We do a one-shot substitution: split on that token and render the link
 * inline. Any other text is rendered verbatim. This avoids pulling in a
 * markdown library for one expected link.
 */
function DisclaimerBody({ text }: { text: string }) {
  const linkRegex = /\[([^\]]+)\]\((\/[^)]+)\)/g;
  const segments: Array<
    { kind: 'text'; value: string } | { kind: 'link'; label: string; href: string }
  > = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'link', label: match[1], href: match[2] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) });
  }

  return (
    <p className="text-sm leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return <Fragment key={i}>{seg.value}</Fragment>;
        }
        return (
          <Link
            key={i}
            to={seg.href}
            className="cursor-pointer text-primary underline-offset-4 hover:underline"
          >
            {seg.label}
          </Link>
        );
      })}
    </p>
  );
}

export function FeeRollupPage() {
  const currentYear = new Date().getUTCFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);

  const yearOptions = useMemo(() => buildYearOptions(currentYear), [currentYear]);

  const { data, isLoading, isError } = useFeeRollup(selectedYear);

  // Reuse the missing-rate prompt hook so the deeplink shape (the rates
  // settings page with `(base, quote)` prefilled) is identical to the
  // dashboard / accounting surfaces. The page-level trigger is the
  // fee-rollup response's own `missingRates` array — the hook supplies
  // the deeplink target for the first pair.
  const { deeplinkTo } = useMissingRatePrompt();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Fee Rollup</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Recorded fill fees aggregated by account and currency for the selected year.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="fee-rollup-year" className="text-xs text-muted-foreground">
              Year
            </label>
            <Select
              value={String(selectedYear)}
              onValueChange={(val) => setSelectedYear(Number(val))}
            >
              <SelectTrigger id="fee-rollup-year" className="w-36 cursor-pointer">
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
        </div>
      </div>

      {data && (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-4 text-foreground">
          <DisclaimerBody text={data.disclaimer} />
          <div className="mt-2 text-sm">
            <Link
              to={TAX_SUMMARY_PATH}
              className="cursor-pointer text-primary underline-offset-4 hover:underline"
            >
              → Tax Summary
            </Link>
          </div>
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
          Failed to load fee rollup. Please try again.
        </div>
      ) : !data || data.totalsByAccount.length === 0 ? (
        <EmptyState
          icon={<ReceiptText className="h-10 w-10" />}
          title={`No recorded fill fees for ${selectedYear}`}
          description="When you record fills with fees, they will be aggregated here by account and currency."
        />
      ) : (
        <>
          <div>
            <h2 className="mb-2 text-lg font-semibold">Per-account totals</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead className="text-right">Stock fees</TableHead>
                  <TableHead className="text-right">Options fees</TableHead>
                  <TableHead className="text-right">Total fees</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.totalsByAccount.map((row) => (
                  <TableRow key={row.accountId}>
                    <TableCell className="font-medium">{row.accountName}</TableCell>
                    <TableCell>{row.currency}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {formatCurrency(parseFloat(row.stockFees), row.currency)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {formatCurrency(parseFloat(row.optionsFees), row.currency)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap font-medium">
                      {formatCurrency(parseFloat(row.totalFees), row.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {data.perCurrencyTotals.length > 0 && (
            <div>
              <h2 className="mb-2 text-lg font-semibold">Per-currency totals</h2>
              <div className="rounded-md border p-4">
                <div className="flex flex-wrap gap-4">
                  {data.perCurrencyTotals.map((row) => (
                    <div key={row.currency} className="text-sm">
                      <span className="font-medium">
                        {formatCurrency(parseFloat(row.totalFees), row.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {data.grandTotal && (
            <div className="rounded-md border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  Grand total ({data.grandTotal.displayCurrency})
                </h2>
                <span className="text-xl font-bold">
                  {formatCurrency(
                    parseFloat(data.grandTotal.totalFees),
                    data.grandTotal.displayCurrency,
                  )}
                </span>
              </div>
              {data.grandTotal.convertedCurrencies.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Converted from: {data.grandTotal.convertedCurrencies.join(', ')}
                </p>
              )}
              {data.grandTotal.excludedCurrencies.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Excluded (missing rate): {data.grandTotal.excludedCurrencies.join(', ')}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

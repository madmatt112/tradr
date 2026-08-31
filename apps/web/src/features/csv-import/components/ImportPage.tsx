import { useEffect, useMemo, useState } from 'react';

import type { CsvPreviewRequest, RowShape } from '@tradr/shared';

import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { isAccountWritable } from '@/features/billing/tier-usage';
import { UpgradeLink } from '@/features/billing/UpgradeLink';
import { useTierState } from '@/features/billing/useTierState';
import { CoachMark } from '@/features/onboarding/components/CoachMark';
import { docsUrl } from '@/lib/docs';

import { useCsvPreview } from '../hooks/useCsvPreview';
import { targetFieldsForShape } from '../lib/fields';
import { readHeaderHints } from '../lib/readHeaderHints';

import { AccountPicker } from './AccountPicker';
import { ColumnMapper, type ColumnMapperValue } from './ColumnMapper';
import { CommitPanel } from './CommitPanel';
import { FileUpload } from './FileUpload';
import { IssueList } from './IssueList';
import { PreviewSummary } from './PreviewSummary';
import { ProposedPositions } from './ProposedPositions';

function previewErrorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'Preview failed. Please try again.';
  const e = err as { error?: { message?: string }; message?: string };
  return e.error?.message ?? e.message ?? 'Preview failed. Please try again.';
}

const initialMapper = (): ColumnMapperValue => ({
  presetId: null,
  rowShape: 'execution',
  // Timezone defaults to UTC for correction (REQ-7.4); the rest are the
  // design defaults.
  mapping: { rowShape: 'execution', columns: {} },
  timezone: 'UTC',
  dateFormat: 'iso',
  numberFormat: 'us',
});

/**
 * CSV Import — the stepwise upload/mapping surface (design Component 13, steps
 * 1–3): select account → upload file → choose preset or map columns (+ row
 * shape, timezone, formats). Task 21 builds steps 1–3 and fires the preview
 * mutation.
 *
 * Task 22 SEAM: the preview/confirm UI renders below where noted. This component
 * already holds the `useCsvPreview` mutation result (`preview`) and the request
 * that produced it; Task 22 extends the marked region (and adds the commit step)
 * without changing the mapping surface above it.
 */
export function ImportPage() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [mapper, setMapper] = useState<ColumnMapperValue>(initialMapper);

  const preview = useCsvPreview();
  const { data: accounts } = useAccounts();
  const { data: tierState } = useTierState();
  const currencyCode = accounts?.find((a) => a.id === accountId)?.currency ?? 'USD';

  // Preselect the user's default account while none is chosen — null is the
  // placeholder, never a choice, so a target the user picked is never
  // overwritten. Withheld when the default is not writable on the current
  // plan: AccountPicker disables that option, and a preselected disabled
  // target would gate the preview on a 403.
  const defaultAccount = accounts?.find((a) => a.isDefault);
  useEffect(() => {
    if (accountId !== null || !defaultAccount) return;
    if (!isAccountWritable(tierState, defaultAccount.id)) return;
    setAccountId(defaultAccount.id);
  }, [accountId, defaultAccount, tierState]);

  // Remaining lifetime CSV imports (plan-tiers REQ-10.3) — disclosed BEFORE
  // staging. `usage` is populated only when gating is on and the user is
  // non-exempt; `null` caps (unlimited) show nothing.
  const csvCap = tierState?.usage ? tierState.limits[tierState.tier].csvImports : null;
  const csvRemaining =
    csvCap !== null && tierState?.usage
      ? Math.max(0, csvCap - tierState.usage.csvImports.used)
      : null;

  // Header-hint extraction for the mapper dropdowns. NOT a CSV parse of the data
  // — only the first line, to surface candidate columns (server does the real
  // parse). Re-reads when the file or chosen delimiter changes.
  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setColumns([]);
      return;
    }
    readHeaderHints(file, mapper.mapping.delimiter ?? ',').then((cols) => {
      if (!cancelled) setColumns(cols);
    });
    return () => {
      cancelled = true;
    };
  }, [file, mapper.mapping.delimiter]);

  const missingRequired = useMemo(() => {
    const fields = targetFieldsForShape(mapper.rowShape);
    const mapped = mapper.mapping.columns;
    const missing = fields.filter((f) => f.required && !mapped[f.field]).map((f) => f.label);
    // execution requires EXACTLY ONE of type | action (REQ-2.2).
    if (mapper.rowShape === 'execution' && !mapped.type && !mapped.action) {
      missing.push('Type or Action');
    }
    return missing;
  }, [mapper.rowShape, mapper.mapping.columns]);

  const canPreview = !!accountId && !!file && missingRequired.length === 0 && !preview.isPending;

  function runPreview() {
    if (!accountId || !file) return;
    const request: CsvPreviewRequest = {
      accountId,
      rowShape: mapper.rowShape,
      mapping: { ...mapper.mapping, rowShape: mapper.rowShape as RowShape },
      presetId: mapper.presetId ?? undefined,
      timezone: mapper.timezone,
      dateFormat: mapper.dateFormat,
      numberFormat: mapper.numberFormat,
    };
    preview.mutate({ file, request });
  }

  // NOTE: the import timezone stays UTC by default — it describes the CSV's own
  // timestamps, not the user's stored reporting zone, so it is deliberately NOT
  // seeded from `useUserTimezone`. The mapper's selector is where it gets
  // corrected.

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        {/* The coach mark is gated on the SAME figure the disclosure below
            is: a user whose plan's lifetime CSV imports are all spent cannot
            import, and `csv-import.service.ts` refuses the commit, so
            introducing the feature to them would be pointing at a door that is
            shut. `undefined` while the tier read is in flight counts as
            unavailable rather than available — better a mark one round trip
            late than one that appears and is then withdrawn. */}
        <PageHeader
          page="Import trades from CSV"
          className="mb-2"
          chips={
            <CoachMark
              surface="csv-import"
              available={tierState !== undefined && csvRemaining !== 0}
            />
          }
        />
        <p className="text-sm text-muted-foreground">
          Imports are additive — they add positions and fills to the target account. Fees come from
          the CSV unless no fees column is mapped.{' '}
          {/* Column mapping is the step people get stuck on, and the answer is
              longer than a tooltip. Link out rather than grow this paragraph. */}
          <a
            href={docsUrl('importHistory')}
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer font-medium text-primary underline underline-offset-2"
          >
            Read the import guide
          </a>
          .
        </p>
        {csvRemaining !== null && (
          <p
            data-testid="csv-imports-remaining"
            className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            <span>
              {csvRemaining} of {csvCap} CSV import{csvCap === 1 ? '' : 's'} remaining on your plan.
            </span>
            {csvRemaining === 0 && tierState?.purchasable && <UpgradeLink surface="csv-import" />}
          </p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Target account</CardTitle>
          <CardDescription>Where the imported trades will be added.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccountPicker value={accountId} onChange={setAccountId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Upload file</CardTitle>
          <CardDescription>The server parses and validates the file.</CardDescription>
        </CardHeader>
        <CardContent>
          <FileUpload file={file} onChange={setFile} />
        </CardContent>
      </Card>

      {file && (
        <Card>
          <CardHeader>
            <CardTitle>3. Map columns</CardTitle>
            <CardDescription>
              Pick a preset to auto-fill, then adjust — or map every field by hand. Set the row
              shape independently of any preset.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ColumnMapper columns={columns} value={mapper} onChange={setMapper} />

            {missingRequired.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Map all required fields to continue: {missingRequired.join(', ')}.
              </p>
            )}

            <Button
              type="button"
              className="cursor-pointer"
              disabled={!canPreview}
              onClick={runPreview}
            >
              {preview.isPending ? 'Previewing…' : 'Preview import'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/*
        ===== Task 22: preview result + confirm/commit UI =====
        Renders the preview result (summary, located errors/warnings, proposed
        positions with proposed P&L) and the confirm/commit controls. The mapping
        surface above this marker is unchanged.
      */}

      {preview.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {preview.isError && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Preview failed</CardTitle>
            <CardDescription>{previewErrorMessage(preview.error)}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {preview.data && !preview.isPending && (
        <div className="space-y-6">
          <PreviewSummary summary={preview.data.summary} />
          <IssueList errors={preview.data.errors} warnings={preview.data.warnings} />
          <ProposedPositions
            positions={preview.data.positions}
            errors={preview.data.errors}
            warnings={preview.data.warnings}
            currencyCode={currencyCode}
          />
          <CommitPanel
            key={preview.data.token}
            preview={preview.data}
            onRePreview={runPreview}
            isRePreviewing={preview.isPending}
          />
        </div>
      )}
    </div>
  );
}

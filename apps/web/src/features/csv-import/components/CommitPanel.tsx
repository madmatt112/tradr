import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import type { CsvCommitResponse, CsvPreviewResponse } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { UpgradeLink } from '@/features/billing/UpgradeLink';
import { useTierState } from '@/features/billing/useTierState';

import { useCsvCommit } from '../hooks/useCsvCommit';

interface CommitPanelProps {
  preview: CsvPreviewResponse;
  /** Re-run preview with the current (unchanged) mapping — used by the superseded refusal. */
  onRePreview: () => void;
  isRePreviewing: boolean;
}

const SUPERSEDED_COPY = 'This preview was replaced by a newer one — re-preview to import it.';

function refusalCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { error?: { code?: string }; code?: string };
  return e.error?.code ?? e.code;
}

function refusalMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'Import failed. Please try again.';
  const e = err as { error?: { message?: string }; message?: string };
  return e.error?.message ?? e.message ?? 'Import failed. Please try again.';
}

/**
 * Confirm/commit controls and result/refusal rendering (REQ-12.3/12.4, design
 * Component 13 steps 4–5).
 *
 * - Confirm is DISABLED while blocking errors remain (`committable === false`).
 * - Near-total (≥90%) duplicate overlap (`requiresDuplicateAffirmation`) requires
 *   a DISTINCT affirmation — a separate checkbox mapped to `confirmDuplicates`,
 *   not the normal confirm — before commit is allowed.
 * - Success → summary + link to imported positions (cache invalidation handled by
 *   the commit hook).
 * - Failure keeps the preview/mapping intact; a SUPERSEDED 409 shows the specific
 *   re-preview message rather than a generic error.
 */
export function CommitPanel({ preview, onRePreview, isRePreviewing }: CommitPanelProps) {
  const commit = useCsvCommit();
  const { data: tierState } = useTierState();
  const [confirmDuplicates, setConfirmDuplicates] = useState(false);

  const result = commit.data as CsvCommitResponse | undefined;
  const error = commit.error;
  const code = error ? refusalCode(error) : undefined;
  const superseded = code === 'CSV_IMPORT_SUPERSEDED';
  // Plan-tiers L6 refusal (REQ-10.3/11.5) — mapped on the CODE only. The
  // staged preview survives a tier refusal server-side, so the same token is
  // re-committable after an upgrade (no re-upload).
  const tierLimited = code === 'TIER_LIMIT_CSV_IMPORTS';

  if (result) {
    return (
      <Card className="border-success/50">
        <CardHeader>
          <CardTitle className="text-base text-success">Import complete</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">
            Added <span className="font-medium">{result.positionsCreated}</span> position
            {result.positionsCreated === 1 ? '' : 's'} and{' '}
            <span className="font-medium">{result.fillsCreated}</span> fill
            {result.fillsCreated === 1 ? '' : 's'} to the target account.
          </p>
          <Button asChild className="cursor-pointer">
            <Link to="/positions">View imported positions</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const blocked = !preview.committable;
  const needsDupAffirmation = preview.requiresDuplicateAffirmation;
  const canCommit = !blocked && (!needsDupAffirmation || confirmDuplicates) && !commit.isPending;

  function runCommit() {
    commit.mutate({ token: preview.token, confirmDuplicates });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Confirm import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {blocked && (
          <p className="text-sm text-destructive">
            Fix the blocking errors above before you can import.
          </p>
        )}

        {needsDupAffirmation && (
          <label className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 cursor-pointer"
              checked={confirmDuplicates}
              onChange={(e) => setConfirmDuplicates(e.target.checked)}
            />
            <span>
              These trades look like duplicates of trades already in this account. Import them
              anyway?
            </span>
          </label>
        )}

        {error != null &&
          (tierLimited ? (
            <div
              data-testid="csv-tier-refusal"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3"
            >
              <span className="text-sm text-destructive">
                You&apos;ve reached your plan&apos;s CSV import limit — this preview stays saved, so
                you can import it after upgrading without re-uploading.
              </span>
              {tierState?.purchasable && <UpgradeLink surface="csv-import" />}
            </div>
          ) : (
            <p className="text-sm text-destructive">
              {superseded ? SUPERSEDED_COPY : refusalMessage(error)}
            </p>
          ))}

        <div className="flex gap-2">
          {superseded ? (
            <Button
              type="button"
              className="cursor-pointer"
              onClick={onRePreview}
              disabled={isRePreviewing}
            >
              {isRePreviewing ? 'Re-previewing…' : 'Re-preview'}
            </Button>
          ) : (
            <Button
              type="button"
              className="cursor-pointer"
              disabled={!canCommit}
              onClick={runCommit}
            >
              {commit.isPending ? 'Importing…' : 'Confirm import'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';

import type { ArchiveCounts, ArchiveDegradation } from '@tradr/shared/schemas/account-archive';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useAccountImportConfirm, useAccountImportPreview } from '../hooks/useAccountImport';
import type { AccountDataFetchError } from '../hooks/useAccountImport';

// The per-category rows the counts table shows, in a reading order that groups
// trading data first and advisor data last. `images` is the archive's image
// total, not an NDJSON entry. `preferences.json` and `dashboard-layout.json` are
// single objects and are not counted (design Data Models).
const COUNT_ROWS: ReadonlyArray<readonly [keyof ArchiveCounts, string]> = [
  ['accounts', 'Accounts'],
  ['positions', 'Positions'],
  ['fills', 'Fills'],
  ['tags', 'Tags'],
  ['positionTags', 'Position tags'],
  ['positionImages', 'Position images'],
  ['ledgerEntries', 'Ledger entries'],
  ['exchangeRates', 'Exchange rates'],
  ['expenses', 'Expenses'],
  ['brokerages', 'Brokerages'],
  ['systemBrokerages', 'System brokerages'],
  ['personas', 'Advisor personas'],
  ['builtinPersonas', 'Built-in personas'],
  ['conversations', 'Advisor conversations'],
  ['messages', 'Advisor messages'],
  ['summaries', 'Advisor summaries'],
  ['images', 'Images'],
];

interface ImportErrorView {
  title: string;
  body: string;
  /** For an invalid archive, the first faults the server reported. */
  faults?: string[];
}

/**
 * Turn a fetch-layer error into a message for the user (design C11, Req 8.5,
 * 10.3). The two responseless markers come first: a confirm that got no response
 * is the Requirement 10.3 case, and a bare 413 is the self-host proxy ceiling.
 * Everything else is keyed on the API's `error.code`; the server's own message
 * already names the categories (not-empty), the cap (too-large) or the retry
 * (busy), so it is surfaced with a client fallback.
 */
export function importErrorView(err: AccountDataFetchError): ImportErrorView {
  if (err.noResponse) {
    return {
      title: 'No response from the server',
      body:
        'Your import may still have completed. Do not run it again yet — reload this page, and ' +
        'if your account now shows data the restore succeeded. A later "account not empty" ' +
        'refusal also means it did.',
    };
  }
  if (err.proxyCeiling) {
    return {
      title: 'The upload was refused before it reached Tradr',
      body:
        'A reverse proxy rejected the file for its size. If you self-host, raise MAX_UPLOAD_SIZE ' +
        '(20m by default) and import again.',
    };
  }

  const code = err.error?.code;
  const serverMessage = err.error?.message ?? err.message;

  if (code === 'ARCHIVE_INVALID') {
    const fields =
      (err.error as { fields?: Array<{ path: string; message: string }> } | undefined)?.fields ??
      [];
    return {
      title: 'This archive is not valid',
      body: 'Tradr could not read the archive. The first problems it found:',
      faults: fields.slice(0, 5).map((f) => `${f.path} — ${f.message}`),
    };
  }
  if (code === 'IMPORT_TARGET_NOT_EMPTY') {
    return {
      title: 'This account is not empty',
      body: serverMessage ?? 'Import needs an empty account.',
    };
  }
  if (code === 'ARCHIVE_TOO_LARGE') {
    return {
      title: 'The archive is too large',
      body: serverMessage ?? 'The archive exceeds a size limit.',
    };
  }
  if (code === 'IMPORT_BUSY') {
    return {
      title: 'The account is busy',
      body: serverMessage ?? 'Another data operation is running; retry shortly.',
    };
  }
  if (code === 'ARCHIVE_VERSION_UNSUPPORTED') {
    return {
      title: 'Unsupported archive version',
      body: serverMessage ?? 'This archive was made by a newer version of Tradr.',
    };
  }
  if (code === 'ARCHIVE_EMPTY') {
    return {
      title: 'The archive is empty',
      body: serverMessage ?? 'The archive contains no importable rows.',
    };
  }
  if (code === 'ARCHIVE_DIGEST_MISMATCH') {
    return {
      title: 'The archive changed',
      body: serverMessage ?? 'Preview the archive again before importing.',
    };
  }
  return {
    title: 'The import could not be completed',
    body: serverMessage ?? 'Something went wrong. Please try again.',
  };
}

function ImportErrorAlert({ error }: { error: AccountDataFetchError }) {
  const view = importErrorView(error);
  return (
    <Alert variant="destructive" data-slot="import-error">
      <AlertTitle>{view.title}</AlertTitle>
      <AlertDescription>
        <p>{view.body}</p>
        {view.faults && view.faults.length > 0 && (
          <ul className="mt-1 list-disc pl-4">
            {view.faults.map((fault) => (
              <li key={fault}>{fault}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

// A short human line per degradation (design C1): an image the export could not
// include, or a dashboard layout the reader could not parse.
function degradationLine(degradation: ArchiveDegradation): string {
  if (degradation.reason === 'object_missing') {
    return `An image could not be included (${degradation.entry}).`;
  }
  return 'The dashboard layout could not be read and was skipped.';
}

function CountsTable({ counts, label }: { counts: ArchiveCounts; label: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Category</TableHead>
          <TableHead className="text-right">{label}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {COUNT_ROWS.map(([key, rowLabel]) => (
          <TableRow key={key}>
            <TableCell>{rowLabel}</TableCell>
            <TableCell className="text-right">{counts[key]}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The import flow on the settings "Data" tab (design C11, Req 10.1/10.3): choose
 * a `.zip`, preview the server's counts, confirm in a dialog, then see the result.
 * The upload never leaves the fetch hooks task 15 exports — the browser sends the
 * `File` as the raw body and reads back JSON.
 */
export function ImportFlow() {
  const queryClient = useQueryClient();
  const preview = useAccountImportPreview();
  const confirm = useAccountImportConfirm();
  const [file, setFile] = useState<File | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const result = confirm.data;

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    setConfirmOpen(false);
    preview.reset();
    confirm.reset();
    setFile(chosen);
    if (chosen) preview.mutate(chosen);
  }

  function runConfirm() {
    if (!file || !preview.data || confirm.isPending) return;
    confirm.mutate(
      { file, digest: preview.data.digest },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          // Everything the app has cached — accounts, positions, dashboards,
          // advisor — is stale after a whole-account restore, so drop the lot
          // (design C11): a keyless invalidation refetches on next use.
          void queryClient.invalidateQueries();
        },
      },
    );
  }

  return (
    <Card data-slot="import-card">
      <CardHeader>
        <CardTitle className="text-base">Import an archive</CardTitle>
        <CardDescription>
          Restore a Tradr export into this account. Import needs an empty account — if yours already
          holds data the import is refused and nothing changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="import-archive-file">Choose an archive (.zip)</Label>
          <Input
            id="import-archive-file"
            type="file"
            accept=".zip,application/zip"
            className="cursor-pointer"
            onChange={onFileChange}
          />
        </div>

        {preview.isPending && (
          <p className="text-sm text-muted-foreground">Checking the archive…</p>
        )}

        {preview.isError && !result && <ImportErrorAlert error={preview.error} />}

        {result ? (
          <div className="space-y-4" data-slot="import-result">
            <div>
              <h3 className="text-sm font-medium">Import complete</h3>
              <p className="text-sm text-muted-foreground">
                Your archive has been restored into this account.
              </p>
            </div>
            <CountsTable counts={result.counts} label="Created" />
            {(result.resolutions.systemBrokerages.length > 0 ||
              result.resolutions.builtinPersonas.length > 0) && (
              <div className="space-y-1 text-sm" data-slot="import-resolutions">
                <p className="font-medium">References resolved</p>
                <ul className="list-disc pl-4 text-muted-foreground">
                  {result.resolutions.systemBrokerages.map((res) => (
                    <li key={`brokerage-${res.name}`}>
                      Brokerage “{res.name}”:{' '}
                      {res.outcome === 'linked'
                        ? 'linked to an existing brokerage'
                        : `created${res.createdName ? ` as “${res.createdName}”` : ''}`}
                    </li>
                  ))}
                  {result.resolutions.builtinPersonas.map((res) => (
                    <li key={`persona-${res.id}`}>
                      Built-in persona “{res.id}”:{' '}
                      {res.outcome === 'matched'
                        ? 'matched on this instance'
                        : 'not found, cleared'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.degradations.length > 0 && (
              <div
                className="space-y-1 text-sm text-muted-foreground"
                data-slot="import-degradations"
              >
                <p className="font-medium">Some data could not be included</p>
                <ul className="list-disc pl-4">
                  {result.degradations.map((degradation, index) => (
                    <li key={index}>{degradationLine(degradation)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          preview.data && (
            <div className="space-y-4" data-slot="import-preview">
              <dl className="text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Exported by</dt>
                  <dd>Tradr {preview.data.sourceAppVersion}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Exported at</dt>
                  <dd>{new Date(preview.data.exportedAt).toLocaleString()}</dd>
                </div>
              </dl>

              <CountsTable counts={preview.data.counts} label="In archive" />

              {preview.data.degradations.length > 0 && (
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p className="font-medium">Some data could not be included in the export</p>
                  <ul className="list-disc pl-4">
                    {preview.data.degradations.map((degradation, index) => (
                      <li key={index}>{degradationLine(degradation)}</li>
                    ))}
                  </ul>
                </div>
              )}

              <Button type="button" className="cursor-pointer" onClick={() => setConfirmOpen(true)}>
                Import this archive
              </Button>

              <Dialog
                open={confirmOpen}
                onOpenChange={(open) => {
                  if (!open && !confirm.isPending) setConfirmOpen(false);
                }}
              >
                <DialogContent data-slot="import-confirm-dialog">
                  <DialogHeader>
                    <DialogTitle>Import this archive?</DialogTitle>
                    <DialogDescription>
                      This restores every account, position, tag and note from the archive. It only
                      works on an empty account; if yours already holds data the import is refused
                      and nothing changes.
                    </DialogDescription>
                  </DialogHeader>

                  {confirm.isError && <ImportErrorAlert error={confirm.error} />}

                  <DialogFooter>
                    <Button
                      variant="outline"
                      className="cursor-pointer"
                      disabled={confirm.isPending}
                      onClick={() => setConfirmOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      className="cursor-pointer"
                      disabled={confirm.isPending}
                      onClick={runConfirm}
                    >
                      {confirm.isPending ? 'Importing…' : 'Import data'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { useAccountExport } from '../hooks/useAccountExport';

/**
 * The download file name, `tradr-export-YYYY-MM-DD.zip`, with the date in UTC.
 *
 * Computed on the client on purpose (design C11). The server names the file the
 * same way in `Content-Disposition`, but that header is not on the CORS
 * allow-list (`apps/api/src/middleware/cors.middleware.ts:12-15` exposes no
 * headers), so a split-origin download cannot read it. UTC rather than local
 * time keeps the name the same wherever the user is.
 */
export function exportFilename(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `tradr-export-${year}-${month}-${day}.zip`;
}

function downloadArchive(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFilename();
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * The export control on the settings "Data" tab (design C11, Req 10.1/10.2): one
 * button that requests the archive and downloads it through an object URL, with
 * loading and error states.
 */
export function ExportCard() {
  const exportMutation = useAccountExport();

  return (
    <Card data-slot="export-card">
      <CardHeader>
        <CardTitle className="text-base">Export your data</CardTitle>
        <CardDescription>
          Download every account, position, tag and note as a single archive you can keep or import
          into another Tradr.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          type="button"
          className="cursor-pointer"
          disabled={exportMutation.isPending}
          onClick={() => exportMutation.mutate(undefined, { onSuccess: downloadArchive })}
        >
          {exportMutation.isPending ? 'Preparing…' : 'Export data'}
        </Button>
        {exportMutation.isError && (
          <p className="text-destructive text-sm" role="alert">
            Could not export your data. Please try again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

import { useMutation } from '@tanstack/react-query';

import type { CsvPreviewRequest, CsvPreviewResponse } from '@tradr/shared';

import { announceSessionExpired, isLoggingOut, resolveApiUrl, setIsLoggingOut } from '@/lib/api';

export interface CsvPreviewArgs {
  file: File;
  request: CsvPreviewRequest;
}

/**
 * Preview a CSV import. The endpoint expects `multipart/form-data` with two
 * parts (design Component 10 / csv-import.route.ts): `file` (the raw CSV) and
 * `request` (a JSON STRING of `CsvPreviewRequest`). We build that FormData by
 * hand rather than going through `lib/api`'s JSON client, but reuse its URL
 * resolver and the shared 401 → logout handling. The browser never parses the
 * CSV — the server does (REQ-12 / tech.md).
 */
async function postPreview({ file, request }: CsvPreviewArgs): Promise<CsvPreviewResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('request', JSON.stringify(request));

  const response = await fetch(resolveApiUrl('/csv-import/preview'), {
    method: 'POST',
    body: form,
    // Session cookie must ride along on split-origin hosted deploys.
    credentials: 'include',
  });

  if (response.status === 401 && !isLoggingOut) {
    setIsLoggingOut(true);
    // The second path that ends a session, and it has to announce it for the
    // same reason `lib/api` does: module-scoped state belonging to the departing
    // user outlives the query cache. A full-document navigation would take it
    // with it eventually, but the teardown runs now rather than whenever the
    // browser gets round to committing the navigation.
    announceSessionExpired();
    window.location.href = '/login?expired=true';
    const err = new Error('Unauthorized') as Error & { status?: number };
    err.status = 401;
    throw err;
  }

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: 'Preview failed', status: response.status }));
    if (typeof error === 'object' && error !== null) {
      (error as { status?: number }).status = response.status;
    }
    throw error;
  }

  return response.json() as Promise<CsvPreviewResponse>;
}

export function useCsvPreview() {
  return useMutation<CsvPreviewResponse, unknown, CsvPreviewArgs>({
    mutationFn: postPreview,
  });
}

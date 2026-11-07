import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { CsvPreviewRequest, CsvPreviewResponse } from '@tradr/shared';

import { ibkrConnectionKeys } from '@/features/ibkr/hooks/useIbkrConnections';
import {
  announceSessionExpired,
  api,
  isLoggingOut,
  resolveApiUrl,
  setIsLoggingOut,
} from '@/lib/api';

export type CsvPreviewArgs = { file: File; request: CsvPreviewRequest } | { flexAccountId: string };

/**
 * Preview an upload. The endpoint expects `multipart/form-data` with two
 * parts (design Component 10 / csv-import.route.ts): `file` (the raw CSV) and
 * `request` (a JSON STRING of `CsvPreviewRequest`). We build that FormData by
 * hand rather than going through `lib/api`'s JSON client, but reuse its URL
 * resolver and the shared 401 → logout handling. The browser never parses the
 * CSV — the server does (REQ-12 / tech.md).
 */
async function postUpload({
  file,
  request,
}: {
  file: File;
  request: CsvPreviewRequest;
}): Promise<CsvPreviewResponse> {
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

/**
 * The flex arm posts only the account id (design C11); the account's stored
 * connection does the rest server-side. It goes through `api.post`, which
 * throws the JSON error body on a non-2xx response, same as the upload arm.
 */
function postFlexFetch(accountId: string): Promise<CsvPreviewResponse> {
  return api.post<CsvPreviewResponse>('/csv-import/flex-fetch', { accountId });
}

function postPreview(args: CsvPreviewArgs): Promise<CsvPreviewResponse> {
  if ('flexAccountId' in args) return postFlexFetch(args.flexAccountId);
  return postUpload(args);
}

export function useCsvPreview() {
  const queryClient = useQueryClient();
  return useMutation<CsvPreviewResponse, unknown, CsvPreviewArgs>({
    mutationFn: postPreview,
    onSettled: (_data, _error, variables) => {
      // Req 7.2 — a settled fetch invalidates the connections query so the
      // last-fetch line updates; the upload arm has no connection to refresh.
      if ('flexAccountId' in variables) {
        queryClient.invalidateQueries({ queryKey: ibkrConnectionKeys.all() });
      }
    },
  });
}

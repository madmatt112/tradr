import { useMutation } from '@tanstack/react-query';

import type { ImportPreview, ImportResult } from '@tradr/shared/schemas/account-archive';

import { announceSessionExpired, isLoggingOut, resolveApiUrl, setIsLoggingOut } from '@/lib/api';

/**
 * The error the import fetch layer throws (design C11). The import flow reads
 * these fields to choose a message, so the shape is the contract: a plain 400
 * carries the API's `error.code`, but two failures have no code to read and get
 * their own marker instead.
 */
export interface AccountDataFetchError {
  /** HTTP status, when a response arrived at all. */
  status?: number;
  /** The API's JSON error envelope, when the body carried one. */
  error?: { code?: string; message?: string; requestId?: string };
  /** A human-readable fallback when there is no envelope. */
  message?: string;
  /**
   * `fetch` itself rejected, so no HTTP response arrived. On a confirm this is
   * the Requirement 10.3 case: the restore may still have committed server-side,
   * and a later "target not empty" refusal means it did.
   */
  noResponse?: boolean;
  /**
   * A 413 whose body carried no JSON `error.code`: the self-host reverse proxy
   * refused the upload at its own ceiling, distinct from the app's
   * `ARCHIVE_TOO_LARGE` cap. The flow tells the operator to raise
   * `MAX_UPLOAD_SIZE` (Requirement 8.5).
   */
  proxyCeiling?: boolean;
}

/**
 * POST a `.zip` archive as the raw request body (design C11). Preview and
 * confirm share this: both send the `File` itself with `Content-Type:
 * application/zip`; confirm alone appends `?digest=`. Errors are normalized into
 * `AccountDataFetchError`.
 */
async function postArchive<T>(path: string, file: File): Promise<T> {
  let response: Response;
  try {
    response = await fetch(resolveApiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
      // Session cookie must ride along on split-origin hosted deploys.
      credentials: 'include',
    });
  } catch {
    // No response at all — a dropped connection or a network fault. On a confirm
    // this is the outcome Requirement 10.3 warns about.
    const err: AccountDataFetchError = {
      noResponse: true,
      message: 'The server did not respond.',
    };
    throw err;
  }

  if (response.status === 401 && !isLoggingOut) {
    setIsLoggingOut(true);
    announceSessionExpired();
    window.location.href = '/login?expired=true';
    const err: AccountDataFetchError = { status: 401, message: 'Unauthorized' };
    throw err;
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const err: AccountDataFetchError = { status: response.status };
    const envelope =
      body && typeof body === 'object' ? (body as AccountDataFetchError).error : undefined;
    if (envelope) {
      err.error = envelope;
    }
    if (
      body &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string'
    ) {
      err.message = (body as { message: string }).message;
    }
    // A proxy's own 413 (nginx replies with HTML, no JSON `error.code`), as
    // opposed to the app cap's ARCHIVE_TOO_LARGE (a JSON code).
    if (response.status === 413 && typeof envelope?.code !== 'string') {
      err.proxyCeiling = true;
    }
    throw err;
  }

  return response.json() as Promise<T>;
}

/**
 * Validate an uploaded archive and return counts, version, degradations and the
 * digest confirm must echo. Writes nothing.
 */
export function useAccountImportPreview() {
  return useMutation<ImportPreview, AccountDataFetchError, File>({
    mutationFn: (file) => postArchive<ImportPreview>('/account-data/import/preview', file),
  });
}

/**
 * Commit a previewed archive. The `digest` is the sha256 hex the preview
 * returned; the server refuses a confirm whose bytes do not match it.
 */
export function useAccountImportConfirm() {
  return useMutation<ImportResult, AccountDataFetchError, { file: File; digest: string }>({
    mutationFn: ({ file, digest }) =>
      postArchive<ImportResult>(`/account-data/import?digest=${digest}`, file),
  });
}

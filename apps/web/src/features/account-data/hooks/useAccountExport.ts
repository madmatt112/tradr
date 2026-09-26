import { useMutation } from '@tanstack/react-query';

import { announceSessionExpired, isLoggingOut, resolveApiUrl, setIsLoggingOut } from '@/lib/api';

/**
 * Start an account export and hand back the archive as a Blob (design C11).
 *
 * NOT the shared JSON `api` client: the response is `application/zip`, not JSON,
 * so the browser must keep it as bytes for the download. The 401 handling
 * mirrors `useCsvPreview` (the other raw-fetch upload path) — a session lost
 * mid-request ends here too, announcing the expiry and redirecting to login.
 */
async function postExport(): Promise<Blob> {
  const response = await fetch(resolveApiUrl('/account-data/export'), {
    method: 'POST',
    // Session cookie must ride along on split-origin hosted deploys.
    credentials: 'include',
  });

  if (response.status === 401 && !isLoggingOut) {
    setIsLoggingOut(true);
    announceSessionExpired();
    window.location.href = '/login?expired=true';
    const err = new Error('Unauthorized') as Error & { status?: number };
    err.status = 401;
    throw err;
  }

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: 'Export failed', status: response.status }));
    if (typeof error === 'object' && error !== null) {
      (error as { status?: number }).status = response.status;
    }
    throw error;
  }

  return response.blob();
}

export function useAccountExport() {
  return useMutation<Blob, unknown, void>({ mutationFn: postExport });
}

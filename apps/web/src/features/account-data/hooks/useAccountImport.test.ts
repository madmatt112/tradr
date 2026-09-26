// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { setIsLoggingOut } from '@/lib/api';

import {
  useAccountImportConfirm,
  useAccountImportPreview,
  type AccountDataFetchError,
} from './useAccountImport';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// A minimal `.zip` (the PK local-file magic); the request never inspects the
// bytes here — `fetch` is mocked — so any File is enough.
function zipFile(): File {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'archive.zip', {
    type: 'application/zip',
  });
}

const DIGEST = 'a'.repeat(64);
const originalLocation = window.location;
let fetchSpy: MockInstance | undefined;

beforeEach(() => {
  // The 401 branch assigns window.location.href; jsdom's real Location rejects
  // that navigation, so replace it to observe the redirect target.
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/settings/data' },
  });
  // Module-scoped in lib/api and set true by the previous 401 test; reset so the
  // 401 branch is armed.
  setIsLoggingOut(false);
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  fetchSpy?.mockRestore();
  vi.restoreAllMocks();
});

async function runConfirm(): Promise<AccountDataFetchError> {
  const { result } = renderHook(() => useAccountImportConfirm(), { wrapper: makeWrapper() });
  let error: AccountDataFetchError = {};
  await act(async () => {
    error = await result.current
      .mutateAsync({ file: zipFile(), digest: DIGEST })
      .then(() => ({}) as AccountDataFetchError)
      .catch((e: unknown) => e as AccountDataFetchError);
  });
  return error;
}

describe('useAccountImport error shapes', () => {
  it('the 401 path redirects to the expiry login and throws a 401', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const error = await runConfirm();

    expect(error.status).toBe(401);
    expect(window.location.href).toBe('/login?expired=true');
  });

  it('marks a 413 with no JSON error.code as the proxy ceiling', async () => {
    // The self-host reverse proxy refuses the upload: nginx replies with HTML,
    // not the app's JSON envelope, so there is no error.code to read.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>413 Request Entity Too Large</html>', {
        status: 413,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const error = await runConfirm();

    expect(error.status).toBe(413);
    expect(error.proxyCeiling).toBe(true);
  });

  it('leaves a 413 that carries ARCHIVE_TOO_LARGE as the app cap, not the proxy ceiling', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'ARCHIVE_TOO_LARGE', message: 'too big' } }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useAccountImportPreview(), { wrapper: makeWrapper() });
    let error: AccountDataFetchError = {};
    await act(async () => {
      error = await result.current
        .mutateAsync(zipFile())
        .then(() => ({}) as AccountDataFetchError)
        .catch((e: unknown) => e as AccountDataFetchError);
    });

    expect(error.status).toBe(413);
    expect(error.proxyCeiling).toBeUndefined();
    expect(error.error?.code).toBe('ARCHIVE_TOO_LARGE');
  });

  it('marks a rejected fetch as no response (Req 10.3)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await runConfirm();

    expect(error.noResponse).toBe(true);
    expect(error.status).toBeUndefined();
  });
});

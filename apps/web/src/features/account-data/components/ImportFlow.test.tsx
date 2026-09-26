// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { ImportFlow } from './ImportFlow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- fixtures --------------------------------------------------------------

// A minimal `.zip` (the PK local-file magic). `fetch` is mocked, so the bytes
// are never inspected; any File is enough.
function zipFile(): File {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'archive.zip', {
    type: 'application/zip',
  });
}

const COUNT_KEYS = [
  'brokerages',
  'systemBrokerages',
  'accounts',
  'tags',
  'positions',
  'fills',
  'positionTags',
  'positionImages',
  'ledgerEntries',
  'exchangeRates',
  'expenses',
  'personas',
  'builtinPersonas',
  'conversations',
  'messages',
  'summaries',
  'images',
] as const;

function counts(overrides: Partial<Record<(typeof COUNT_KEYS)[number], number>> = {}) {
  const base = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  return { ...base, ...overrides };
}

function previewBody(overrides: Record<string, unknown> = {}) {
  return {
    counts: counts({ accounts: 2, positions: 42 }),
    sourceAppVersion: '0.13.0',
    exportedAt: '2026-09-26T12:00:00.000000Z',
    degradations: [],
    digest: 'a'.repeat(64),
    ...overrides,
  };
}

function resultBody(overrides: Record<string, unknown> = {}) {
  return {
    counts: counts({ accounts: 2, positions: 42 }),
    degradations: [],
    resolutions: { systemBrokerages: [], builtinPersonas: [] },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---- harness ---------------------------------------------------------------

let fetchSpy: MockInstance | undefined;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  });
}

function renderFlow() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  const utils = render(<ImportFlow />, { wrapper: Wrapper });
  return { qc, invalidateSpy, ...utils };
}

function chooseFile() {
  const input = screen.getByLabelText(/Choose an archive/i);
  fireEvent.change(input, { target: { files: [zipFile()] } });
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/settings/data' },
  });
});

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  vi.restoreAllMocks();
});

// ---- tests -----------------------------------------------------------------

describe('ImportFlow', () => {
  it('choose: renders a file input and no preview yet', () => {
    renderFlow();
    expect(screen.getByLabelText(/Choose an archive/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Import this archive/i })).toBeNull();
  });

  it('preview → confirm → result: shows counts, version and date, then invalidates all queries', async () => {
    mockFetch((url) =>
      url.includes('/import/preview') ? json(previewBody()) : json(resultBody()),
    );
    const { invalidateSpy } = renderFlow();

    chooseFile();

    // Preview: the server counts (integers), the source version and the date.
    expect(await screen.findByText('42')).toBeTruthy();
    expect(screen.getByText(/0\.13\.0/)).toBeTruthy();
    expect(screen.getByText('Accounts')).toBeTruthy();

    // Confirm dialog.
    fireEvent.click(screen.getByRole('button', { name: /Import this archive/i }));
    const confirmButton = await screen.findByRole('button', { name: /Import data/i });
    fireEvent.click(confirmButton);

    // Result and a keyless invalidation.
    expect(await screen.findByText(/Import complete/i)).toBeTruthy();
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith();
  });

  it('not-empty: names the categories the account already has', async () => {
    mockFetch(() =>
      json(
        {
          error: {
            code: 'IMPORT_TARGET_NOT_EMPTY',
            message:
              'The account already has data (accounts, positions); import needs an empty account.',
          },
        },
        409,
      ),
    );
    renderFlow();

    chooseFile();

    expect(await screen.findByText(/not empty/i)).toBeTruthy();
    expect(screen.getByText(/accounts, positions/)).toBeTruthy();
  });

  it('invalid: lists the first faults', async () => {
    mockFetch(() =>
      json(
        {
          error: {
            code: 'ARCHIVE_INVALID',
            message: 'The archive is not valid.',
            fields: [
              { path: 'positions[12].symbol', code: 'too_big', message: 'too long' },
              { path: 'accounts[0].currency', code: 'invalid_enum', message: 'unknown code' },
            ],
          },
        },
        400,
      ),
    );
    renderFlow();

    chooseFile();

    expect(await screen.findByText(/not valid/i)).toBeTruthy();
    expect(screen.getByText(/positions\[12\]\.symbol/)).toBeTruthy();
    expect(screen.getByText(/accounts\[0\]\.currency/)).toBeTruthy();
  });

  it('too-large: names the cap and its value', async () => {
    mockFetch(() =>
      json(
        {
          error: {
            code: 'ARCHIVE_TOO_LARGE',
            message: 'Archive exceeds the maxUploadBytes limit of 536870912 bytes.',
          },
        },
        413,
      ),
    );
    renderFlow();

    chooseFile();

    expect(await screen.findByText(/too large/i)).toBeTruthy();
    expect(screen.getByText(/maxUploadBytes limit of 536870912/)).toBeTruthy();
  });

  it('proxy 413: tells the operator to raise MAX_UPLOAD_SIZE', async () => {
    // The self-host reverse proxy refuses the upload: nginx replies with HTML,
    // not the app's JSON envelope, so there is no error.code to read.
    mockFetch(
      () =>
        new Response('<html>413 Request Entity Too Large</html>', {
          status: 413,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    renderFlow();

    chooseFile();

    expect(await screen.findByText(/refused before it reached Tradr/i)).toBeTruthy();
    expect(screen.getByText(/MAX_UPLOAD_SIZE/)).toBeTruthy();
  });

  it('busy: a 503 at confirm says retry shortly', async () => {
    mockFetch((url) =>
      url.includes('/import/preview')
        ? json(previewBody())
        : json(
            {
              error: {
                code: 'IMPORT_BUSY',
                message: 'The account is busy with another data operation; retry shortly.',
              },
            },
            503,
          ),
    );
    renderFlow();

    chooseFile();
    fireEvent.click(await screen.findByRole('button', { name: /Import this archive/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Import data/i }));

    expect(await screen.findByText(/retry shortly/i)).toBeTruthy();
    expect(screen.getAllByText(/busy/i).length).toBeGreaterThan(0);
  });

  it('no response at confirm: shows the Requirement 10.3 notice', async () => {
    mockFetch((url) => {
      if (url.includes('/import/preview')) return json(previewBody());
      throw new TypeError('Failed to fetch');
    });
    renderFlow();

    chooseFile();
    fireEvent.click(await screen.findByRole('button', { name: /Import this archive/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Import data/i }));

    expect(await screen.findByText(/No response from the server/i)).toBeTruthy();
    expect(screen.getByText(/may still have completed/i)).toBeTruthy();
  });
});

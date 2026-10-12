// @vitest-environment jsdom
//
// Red tests for task 13 (security-hardening): the two-factor section on the
// account settings page. Reaches the behaviour only through rendering
// `<TwoFactorSection />` under a real QueryClientProvider, with the global
// `fetch` mocked — the same seam `_auth.settings.account.test.tsx` uses for
// the rest of that page. No internal collaborator (the `useTwoFactor` hook)
// is mocked; `qrcode` is mocked because task 13 is the one that installs it
// (not yet present under node_modules) and because asserting a real QR
// render would test a third-party library, not this component.
//
// DOM contract this file fixes for the implementation (task 13's own Success
// bullets, and Req 1.2/1.6/1.7/1.8/1.10):
//   - a `data-testid="two-factor-status"` badge reading "On" or "Off";
//   - Off: a "Set up two-factor" button;
//   - starting enrolment renders a `data-testid="two-factor-canvas"` <canvas>
//     and the base32 secret as visible text (the "text key");
//   - a code input + "Confirm" button inside `data-testid="two-factor-enrol"`;
//   - confirming shows all 10 backup codes once, in
//     `data-testid="two-factor-backup-codes"`, plus a "Copy codes" button;
//   - On: a `data-testid="two-factor-regenerate"` section with a code input
//     and a "Regenerate backup codes" button, disabled until a code is typed;
//   - On: a "Turn off" button opening a dialog with a password field, a code
//     field, and a "Turn off two-factor" submit, disabled until both fields
//     are filled; success returns the section to the Off state.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { TwoFactorSection } from './TwoFactorSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no navigator.clipboard — install a stub (OccCard.test.tsx precedent).
let clipboardWriteText: ReturnType<typeof vi.fn>;

// qrcode@1.5.4 is a new dependency task 13 installs (not yet under
// node_modules); mocked so the component's dynamic `import('qrcode')`
// resolves deterministically under test. `toCanvas` is recorded so the test
// can assert the component drew the otpauth URI onto its own <canvas>.
const toCanvas = vi.fn(async (canvas: HTMLCanvasElement, text: string) => {
  canvas.setAttribute('data-qr-text', text);
});
vi.mock('qrcode', () => ({ default: { toCanvas } }));

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SECRET = 'JBSWY3DPEHPK3PXP';
const OTPAUTH_URI =
  'otpauth://totp/Tradr:me%40user.dev?secret=JBSWY3DPEHPK3PXP&issuer=Tradr&algorithm=SHA1&digits=6&period=30';
const FIRST_CODES = Array.from({ length: 10 }, (_, i) => `aaaaa-bbbb${i}`);
const REGEN_CODES = Array.from({ length: 10 }, (_, i) => `ccccc-dddd${i}`);

// Mutable per-test fixtures (rebound in beforeEach, following the
// _auth.settings.account.test.tsx fixture-fetch pattern).
let statusEnabled: boolean;
let enrolBody: () => unknown;
let confirmBody: () => unknown;
let backupCodesBody: () => unknown;
let disableBody: () => unknown;
let fetchSpy: MockInstance | null = null;

function lastBodyFor(urlFragment: string): unknown {
  const call = fetchSpy!.mock.calls
    .slice()
    .reverse()
    .find((args) => String(args[0]).includes(urlFragment));
  if (!call) throw new Error(`No fetch call recorded for ${urlFragment}`);
  const init = call[1] as RequestInit | undefined;
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

beforeEach(() => {
  statusEnabled = false;
  enrolBody = () => ({ secret: SECRET, otpauthUri: OTPAUTH_URI });
  confirmBody = () => ({ backupCodes: FIRST_CODES });
  backupCodesBody = () => ({ backupCodes: REGEN_CODES });
  disableBody = () => ({ enabled: false });

  clipboardWriteText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });

  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/auth/two-factor/enrol/confirm')) return jsonResponse(200, confirmBody());
      if (url.includes('/auth/two-factor/enrol')) return jsonResponse(200, enrolBody());
      if (url.includes('/auth/two-factor/backup-codes'))
        return jsonResponse(200, backupCodesBody());
      if (url.includes('/auth/two-factor/disable')) return jsonResponse(200, disableBody());
      if (url.includes('/auth/two-factor') && method === 'GET')
        return jsonResponse(200, { enabled: statusEnabled });
      throw new Error(`Unexpected fetch in test: ${method} ${url}`);
    });
  toCanvas.mockClear();
});

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

function renderSection() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <TwoFactorSection />
    </QueryClientProvider>,
  );
  return qc;
}

describe('TwoFactorSection', () => {
  // Pre-condition: GET /auth/two-factor answers { enabled: false } (Req 1.1,
  // every account starts off). Call: render <TwoFactorSection />. Observable
  // result: a neutral "Off" status badge and a "Set up two-factor" button, no
  // QR canvas. Expected value source: task 13's Success bullet "Off shows the
  // set-up button" and Req 1.10 (settings page shows whether two-factor is on).
  it('off: shows the "Off" status and the set-up button, no QR canvas', async () => {
    renderSection();

    const badge = await screen.findByTestId('two-factor-status');
    expect(badge.textContent).toContain('Off');
    expect(badge.getAttribute('data-variant')).not.toBe('destructive');

    expect(screen.getByRole('button', { name: 'Set up two-factor' })).toBeTruthy();
    expect(screen.queryByTestId('two-factor-canvas')).toBeNull();
  });

  // Pre-condition: off, then "Set up two-factor" is clicked, and
  // POST /auth/two-factor/enrol answers { secret, otpauthUri } (Req 1.2: a
  // TOTP secret shown as a QR code and as a text key). Call: fireEvent.click
  // the set-up button. Observable result: a canvas exists and the mocked
  // qrcode.toCanvas was called with that canvas and the otpauth URI; the
  // base32 secret is visible as plain text (the text key). Expected value
  // source: the enrol fixture's `secret`/`otpauthUri`, and Req 1.2.
  it('enrolment: starting it draws the otpauth URI on a canvas and shows the secret as a text key', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-factor' }));

    const canvas = await screen.findByTestId('two-factor-canvas');
    await waitFor(() => expect(toCanvas).toHaveBeenCalledTimes(1));
    expect(toCanvas.mock.calls[0][0]).toBe(canvas);
    expect(toCanvas.mock.calls[0][1]).toBe(OTPAUTH_URI);

    expect(screen.getByText(SECRET)).toBeTruthy();
  });

  // Pre-condition: enrolment started (QR + text key showing), a code is typed
  // and "Confirm" is clicked; POST /auth/two-factor/enrol/confirm answers
  // { backupCodes: [10 codes] } (Req 1.6: 10 single-use backup codes shown
  // once, with a copy action). Call: fireEvent.click the "Confirm" button, then
  // the "Copy codes" button. Observable result: all 10 codes render once, and
  // clicking "Copy codes" writes a string containing every one of them to the
  // clipboard. Expected value source: the confirm fixture's `backupCodes`
  // array (FIRST_CODES) and Req 1.6.
  it('confirm: a valid code shows all 10 backup codes once, with a working copy button', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-factor' }));
    const enrolSection = await screen.findByTestId('two-factor-enrol');

    fireEvent.change(within(enrolSection).getByRole('textbox'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(enrolSection).getByRole('button', { name: 'Confirm' }));

    const codesBlock = await screen.findByTestId('two-factor-backup-codes');
    for (const code of FIRST_CODES) {
      expect(within(codesBlock).getByText(code)).toBeTruthy();
    }
    expect(lastBodyFor('/auth/two-factor/enrol/confirm')).toEqual({ code: '123456' });

    fireEvent.click(screen.getByRole('button', { name: 'Copy codes' }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1));
    const copied = clipboardWriteText.mock.calls[0][0] as string;
    for (const code of FIRST_CODES) {
      expect(copied).toContain(code);
    }
  });

  // Pre-condition: two-factor already on (GET /auth/two-factor →
  // { enabled: true }). Call: render, then type a code into the regenerate
  // section's input and click "Regenerate backup codes". Observable result:
  // the button is disabled with an empty code (Req 1.7 "needs a valid TOTP
  // code"), becomes enabled once a code is typed, and on click
  // POST /auth/two-factor/backup-codes is sent with that code and the 10 new
  // codes from the fixture replace the view. Expected value source: Req 1.7
  // and Req 1.10's "On" branch; the new codes come from REGEN_CODES.
  it('regenerate: the button needs a code, then voids the old codes for 10 new ones', async () => {
    statusEnabled = true;
    renderSection();

    const badge = await screen.findByTestId('two-factor-status');
    expect(badge.textContent).toContain('On');

    const regenSection = await screen.findByTestId('two-factor-regenerate');
    const regenButton = within(regenSection).getByRole('button', {
      name: 'Regenerate backup codes',
    });
    expect((regenButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(regenSection).getByRole('textbox'), {
      target: { value: '654321' },
    });
    expect((regenButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(regenButton);

    const codesBlock = await screen.findByTestId('two-factor-backup-codes');
    for (const code of REGEN_CODES) {
      expect(within(codesBlock).getByText(code)).toBeTruthy();
    }
    expect(lastBodyFor('/auth/two-factor/backup-codes')).toEqual({ code: '654321' });
  });

  // Pre-condition: two-factor on. Call: click "Turn off" to open the dialog,
  // then fill the password and code fields and click "Turn off two-factor";
  // POST /auth/two-factor/disable answers { enabled: false } (Req 1.8: turning
  // off requires the password and a valid code). Observable result: the submit
  // is disabled until both fields are filled, the request body carries both
  // values, and afterwards the section returns to the "Off" state with the
  // "Set up two-factor" button back. Expected value source: Req 1.8 and Req
  // 1.10's return to "Off".
  it('disable: needs both the password and a code, then returns the section to "Off"', async () => {
    statusEnabled = true;
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog');

    const submit = within(dialog).getByRole('button', { name: 'Turn off two-factor' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/password/i), {
      target: { value: 'correct-horse-battery' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole('textbox', { name: /code/i }), {
      target: { value: '111222' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submit);

    await waitFor(() => {
      expect(lastBodyFor('/auth/two-factor/disable')).toEqual({
        password: 'correct-horse-battery',
        code: '111222',
      });
    });

    await screen.findByRole('button', { name: 'Set up two-factor' });
    expect(screen.getByTestId('two-factor-status').textContent).toContain('Off');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

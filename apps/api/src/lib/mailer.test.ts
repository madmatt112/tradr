import type { Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { Config } from './config';

// The vitest workspace pins all seven email env vars to '' — a fresh config
// parse is always unconfigured. Each behavior test loads a FRESH module graph
// (vi.resetModules — the posthog.test.ts singleton-reset pattern) and mutates
// the fresh `config` instance directly (the app.split-origin.test.ts pattern;
// isEmailConfigured/dispatchEmail read config live), so no cross-test state
// (transporter singleton, in-flight Set) survives.

const CONFIGURED: Partial<Config> = {
  SMTP_HOST: 'smtp.tradr.test',
  SMTP_PORT: 587,
  SMTP_TLS_MODE: 'starttls',
  EMAIL_FROM: 'no-reply@tradr.test',
  EMAIL_FROM_NAME: 'Tradr',
  WEB_BASE_URL: 'https://app.tradr.test',
};

async function load(overrides: Partial<Config> = {}) {
  vi.resetModules();
  const { config } = await import('./config');
  Object.assign(config, { ...CONFIGURED, ...overrides });
  const mailer = await import('./mailer');
  const templates = await import('./email-templates');
  const { logger } = await import('./logger');
  // Silenced spy: these tests assert log args, not stdout output.
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  return { config, mailer, templates, warnSpy };
}

function stubTransport(sendMail: Mock): Transporter {
  return { sendMail } as unknown as Transporter;
}

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush one macrotask turn (and with it, all queued microtask chains).
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── buildTransportOptions — the direct mapping tests (MN-4: the override
// seam bypasses createTransport, so the mapping MUST be tested here) ─────────
describe('buildTransportOptions', () => {
  const base = {
    SMTP_HOST: 'smtp.tradr.test',
    SMTP_PORT: 2525,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
  };

  it('maps implicit → secure: true (no STARTTLS flags)', async () => {
    const { mailer } = await load();
    const opts = mailer.buildTransportOptions({ ...base, SMTP_TLS_MODE: 'implicit' });
    expect(opts.secure).toBe(true);
    expect(opts.requireTLS).toBeUndefined();
    expect(opts.ignoreTLS).toBeUndefined();
  });

  it('maps starttls → secure: false + requireTLS: true (mandatory upgrade)', async () => {
    const { mailer } = await load();
    const opts = mailer.buildTransportOptions({ ...base, SMTP_TLS_MODE: 'starttls' });
    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true);
    expect(opts.ignoreTLS).toBeUndefined();
  });

  it('maps none → secure: false + ignoreTLS: true (plaintext relays)', async () => {
    const { mailer } = await load();
    const opts = mailer.buildTransportOptions({ ...base, SMTP_TLS_MODE: 'none' });
    expect(opts.secure).toBe(false);
    expect(opts.ignoreTLS).toBe(true);
    expect(opts.requireTLS).toBeUndefined();
  });

  it('pins host/port pass-through, pool: false, and the 10/10/20 s timeouts', async () => {
    const { mailer } = await load();
    const opts = mailer.buildTransportOptions({ ...base, SMTP_TLS_MODE: 'starttls' });
    expect(opts.host).toBe('smtp.tradr.test');
    expect(opts.port).toBe(2525);
    expect(opts.pool).toBe(false);
    expect(opts.connectionTimeout).toBe(10_000);
    expect(opts.greetingTimeout).toBe(10_000);
    expect(opts.socketTimeout).toBe(20_000);
  });

  it('includes auth only when BOTH SMTP_USER and SMTP_PASS are set', async () => {
    const { mailer } = await load();
    const withAuth = mailer.buildTransportOptions({
      ...base,
      SMTP_TLS_MODE: 'starttls',
      SMTP_USER: 'mailer',
      SMTP_PASS: 's3cret',
    });
    expect(withAuth.auth).toEqual({ user: 'mailer', pass: 's3cret' });
    const withoutAuth = mailer.buildTransportOptions({ ...base, SMTP_TLS_MODE: 'starttls' });
    expect(withoutAuth.auth).toBeUndefined();
  });
});

// ─── dispatchEmail ───────────────────────────────────────────────────────────
describe('dispatchEmail', () => {
  it('unconfigured: initMailer + dispatchEmail are silent no-ops', async () => {
    const { mailer, warnSpy } = await load({
      SMTP_HOST: undefined,
      EMAIL_FROM: undefined,
      WEB_BASE_URL: undefined,
    });
    const sendMail = vi.fn();

    mailer.initMailer(stubTransport(sendMail));
    mailer.dispatchEmail('password_reset', 'user@example.com', 'tok');

    expect(sendMail).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('configured but uninitialized (initMailer never ran): no-op', async () => {
    const { mailer, warnSpy } = await load();

    expect(() => mailer.dispatchEmail('password_reset', 'user@example.com', 'tok')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('sends the Task 4 content with the escape-safe from-address object', async () => {
    const { mailer, templates } = await load();
    const sendMail = vi.fn().mockResolvedValue({});
    mailer.initMailer(stubTransport(sendMail));

    mailer.dispatchEmail('password_reset', 'user@example.com', 'a'.repeat(64));

    const expected = templates.buildEmail('password_reset', 'a'.repeat(64));
    expect(sendMail).toHaveBeenCalledTimes(1);
    // Exact-object match: from MUST be the { name, address } object form
    // (never a formatted string — MN-4), and no extra fields ride along.
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'Tradr', address: 'no-reply@tradr.test' },
      to: 'user@example.com',
      subject: expected.subject,
      text: expected.text,
      html: expected.html,
    });
    await mailer.drainMailer();
  });

  it('omits the display name as an empty string when EMAIL_FROM_NAME is unset', async () => {
    const { mailer } = await load({ EMAIL_FROM_NAME: undefined });
    const sendMail = vi.fn().mockResolvedValue({});
    mailer.initMailer(stubTransport(sendMail));

    mailer.dispatchEmail('email_verification', 'user@example.com', 'tok');

    const message = sendMail.mock.calls[0][0] as { from: unknown };
    expect(message.from).toEqual({ name: '', address: 'no-reply@tradr.test' });
    await mailer.drainMailer();
  });

  it('caps in-flight sends at 5: the 6th is dropped and logged at warn', async () => {
    const { mailer, warnSpy } = await load();
    // Never-resolving sends: all five stay in flight.
    const sendMail = vi.fn(() => new Promise(() => {}));
    mailer.initMailer(stubTransport(sendMail));

    for (let i = 0; i < 6; i++) {
      mailer.dispatchEmail('password_reset', `user${i}@example.com`, `tok${i}`);
    }

    expect(sendMail).toHaveBeenCalledTimes(mailer.MAX_IN_FLIGHT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, extra] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('email_send_dropped_capacity');
    expect(Object.keys(extra).sort()).toEqual(['error', 'purpose']);
    expect(extra.purpose).toBe('password_reset');
  });

  it('catches a rejected send and logs the allowlisted fields only (no unhandled rejection)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { mailer, warnSpy } = await load();
      // Nodemailer recipient-rejection errors embed the address in the
      // message — the scrub must strip it before the stdout log line.
      const sendMail = vi
        .fn()
        .mockRejectedValue(new Error('Message failed: 550 <victim@example.com> rejected'));
      mailer.initMailer(stubTransport(sendMail));

      mailer.dispatchEmail('email_verification', 'victim@example.com', 'f'.repeat(64));
      await mailer.drainMailer();
      await tick(); // give any would-be unhandledRejection its process tick

      // House logger.warn(message, extra) shape: the event name IS the message
      // arg; the extra arg's keys are EXACTLY { purpose, error } (MN-2/REQ-2.5).
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message, extra] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toBe('email_send_failed');
      expect(Object.keys(extra).sort()).toEqual(['error', 'purpose']);
      expect(extra.purpose).toBe('email_verification');
      expect(extra.error).toBe('Message failed: 550 <[redacted]> rejected');
      // Neither arg carries the recipient address or the raw token — even
      // when the SMTP error message itself embeds the address.
      const logged = JSON.stringify(warnSpy.mock.calls[0]);
      expect(logged).not.toContain('victim@example.com');
      expect(logged).not.toContain('f'.repeat(64));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('frees cap slots once sends settle (including failed ones)', async () => {
    const { mailer } = await load();
    const d = deferred();
    const sendMail = vi.fn(() => d.promise);
    mailer.initMailer(stubTransport(sendMail));

    for (let i = 0; i < 5; i++) {
      mailer.dispatchEmail('password_reset', `user${i}@example.com`, `tok${i}`);
    }
    d.resolve({});
    await mailer.drainMailer();

    mailer.dispatchEmail('password_reset', 'late@example.com', 'tok-late');
    expect(sendMail).toHaveBeenCalledTimes(6); // not dropped — slots freed
    await mailer.drainMailer();
  });
});

// ─── drainMailer ─────────────────────────────────────────────────────────────
describe('drainMailer', () => {
  it('resolves instantly when nothing is in flight (even unconfigured)', async () => {
    const { mailer } = await load({
      SMTP_HOST: undefined,
      EMAIL_FROM: undefined,
      WEB_BASE_URL: undefined,
    });
    vi.useFakeTimers();
    // No timer advance needed — the drain loop never starts.
    await expect(mailer.drainMailer()).resolves.toBeUndefined();
  });

  it('waits for in-flight sends to settle, then resolves', async () => {
    const { mailer } = await load();
    const d = deferred();
    mailer.initMailer(stubTransport(vi.fn(() => d.promise)));
    mailer.dispatchEmail('password_reset', 'user@example.com', 'tok');

    let drained = false;
    const drain = mailer.drainMailer().then(() => {
      drained = true;
    });
    await tick();
    expect(drained).toBe(false); // still in flight

    d.resolve({});
    await drain;
    expect(drained).toBe(true);
  });

  it('is bounded by the timeout when a send hangs (never rejects)', async () => {
    const { mailer } = await load();
    mailer.initMailer(stubTransport(vi.fn(() => new Promise(() => {}))));
    mailer.dispatchEmail('password_reset', 'user@example.com', 'tok');

    vi.useFakeTimers();
    const drain = mailer.drainMailer(); // default MAILER_DRAIN_TIMEOUT_MS bound
    await vi.advanceTimersByTimeAsync(mailer.MAILER_DRAIN_TIMEOUT_MS);
    await expect(drain).resolves.toBeUndefined();
  });

  it('re-snapshots: a send dispatched between snapshots is still drained (the loop)', async () => {
    const { mailer } = await load();
    const first = deferred();
    const second = deferred();
    const sendMail = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mailer.initMailer(stubTransport(sendMail));

    mailer.dispatchEmail('password_reset', 'user@example.com', 'tok1');
    let drained = false;
    const drain = mailer.drainMailer().then(() => {
      drained = true;
    });
    await tick(); // drain is now awaiting snapshot #1 (the first send only)

    // Dispatched BETWEEN snapshots — a single-snapshot drain would miss it.
    mailer.dispatchEmail('email_verification', 'user@example.com', 'tok2');
    first.resolve({});
    await tick();
    await tick();
    expect(drained).toBe(false); // loop re-snapshotted and is draining send #2

    second.resolve({});
    await drain;
    expect(drained).toBe(true);
  });
});

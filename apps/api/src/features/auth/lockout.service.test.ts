// Tests for lockout.service.ts's sendUnlockEmail (design C3, Task 5, Req 4.7,
// 4.8, 4.10). Real Postgres via the test-setup rollback transaction (per-test
// SAVEPOINT isolation); email config toggled by direct config.X mutation (the
// password-reset.test.ts pattern — isEmailConfigured() reads config live); the
// mailer's transportOverride seam observes dispatches without a real SMTP
// server (mailer.ts:95-104).

import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { emailTokens } from '@/db/schema';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import { initMailer } from '@/lib/mailer';

import { insertUser } from './auth.query';
import { sendUnlockEmail } from './lockout.service';

let emailCounter = 0;
function uniqueEmail() {
  return `lockout-unlock-${++emailCounter}@example.com`;
}

async function createUser(email: string) {
  return insertUser(db, { email, passwordHash: 'x' });
}

function unlockRowsFor(userId: string) {
  return db
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, 'account_unlock')));
}

// --- email config toggling (direct mutation + restore; predicate reads live) ---
const ORIGINAL = {
  SMTP_HOST: config.SMTP_HOST,
  EMAIL_FROM: config.EMAIL_FROM,
  WEB_BASE_URL: config.WEB_BASE_URL,
};

function configureEmail() {
  config.SMTP_HOST = 'smtp.test.local';
  config.EMAIL_FROM = 'noreply@test.local';
  config.WEB_BASE_URL = 'https://app.test.local';
}

afterEach(() => {
  config.SMTP_HOST = ORIGINAL.SMTP_HOST;
  config.EMAIL_FROM = ORIGINAL.EMAIL_FROM;
  config.WEB_BASE_URL = ORIGINAL.WEB_BASE_URL;
  vi.restoreAllMocks();
});

type SentMail = { to: string; text: string };

function stubTransport() {
  const sendMail = vi.fn().mockResolvedValue({});
  initMailer({ sendMail } as unknown as Transporter);
  return sendMail;
}

describe('sendUnlockEmail', () => {
  // Req 4.7 + 4.8: configured and an account exists — one live account_unlock
  // token is issued and the mailer gets exactly one message carrying the
  // unlock-page link (proving dispatchEmail was called with an
  // `account_unlock` EmailMessage, not merely called at all).
  it('configured: issues one live account_unlock token and dispatches one unlock email', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const email = uniqueEmail();
    const user = await createUser(email);

    await sendUnlockEmail(user.id, email);

    const rows = await unlockRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].consumedAt).toBeNull();

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0] as SentMail;
    expect(mail.to).toBe(email);
    expect(mail.text).toContain('/unlock-account#token=');
  });

  // Req 4.10: unconfigured — no token row is produced and nothing is sent.
  // The stub is installed WHILE configured (so it is genuinely the active
  // transporter) and only then is email de-configured, so a guard that forgot
  // the isEmailConfigured() check would still reach this very stub.
  it('unconfigured: produces no account_unlock token row and sends nothing', async () => {
    configureEmail();
    const sendMail = stubTransport();
    config.SMTP_HOST = ''; // breaks the {SMTP_HOST, EMAIL_FROM, WEB_BASE_URL} trio
    const email = uniqueEmail();
    const user = await createUser(email);

    await sendUnlockEmail(user.id, email);

    expect(await unlockRowsFor(user.id)).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  // Reliability NFR: an issuance failure is caught, logged with userId and
  // purpose only (never the address), and does not throw. A non-existent
  // userId forces a genuine foreign-key failure on the token insert — no
  // collaborator is mocked to fake the failure.
  it('an issuance failure is logged with userId and purpose only and does not throw', async () => {
    configureEmail();
    stubTransport();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const email = uniqueEmail();
    const bogusUserId = crypto.randomUUID(); // no matching users row

    await expect(sendUnlockEmail(bogusUserId, email)).resolves.toBeUndefined();

    const calls = [...warnSpy.mock.calls, ...errorSpy.mock.calls];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, extra] of calls) {
      expect(extra).toMatchObject({ userId: bogusUserId, purpose: 'account_unlock' });
      expect(JSON.stringify(extra ?? {})).not.toContain(email);
    }
  });
});

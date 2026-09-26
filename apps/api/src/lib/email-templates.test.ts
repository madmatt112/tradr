import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '@/lib/config';
import { buildEmail, type EmailMessage } from '@/lib/email-templates';

// Unit tests for the transactional-email templates (Task 4, Component 3).
// Pins REQ-3.1's two mandated content elements (expiry statement +
// didn't-request notice), the D6 fragment-carry link shape (REQ-3.9), and
// the raw-token-only-in-the-link invariant. WEB_BASE_URL is pinned '' in the
// vitest workspace env, so config.WEB_BASE_URL starts undefined here and is
// driven by direct config mutation + restore (the app.split-origin.test.ts
// pattern) — which also proves the module reads it live, not at import time.

const BASE = 'https://app.example.com';
const TOKEN = '0f'.repeat(32); // 64 lowercase hex chars — the TokenField shape
const ORIGINAL = config.WEB_BASE_URL;

beforeEach(() => {
  config.WEB_BASE_URL = BASE;
});

afterEach(() => {
  config.WEB_BASE_URL = ORIGINAL;
});

type Pin = {
  message: EmailMessage;
  subject: string;
  link: string;
  expiry: string;
  notice: string;
};

const PINS: Pin[] = [
  {
    message: { kind: 'password_reset', rawToken: TOKEN },
    subject: 'Reset your Tradr password',
    link: `${BASE}/reset-password#token=${TOKEN}`,
    expiry: 'This link expires in 60 minutes.',
    notice: "If you didn't request this, you can ignore this email — your password is unchanged.",
  },
  {
    message: { kind: 'email_verification', rawToken: TOKEN },
    subject: 'Verify your email address',
    link: `${BASE}/verify-email#token=${TOKEN}`,
    expiry: 'This link expires in 24 hours.',
    notice: "If you didn't request this, you can ignore this email.",
  },
];

describe.each(PINS)('buildEmail($message.kind)', ({ message, subject, link, expiry, notice }) => {
  it('uses the pinned subject', () => {
    expect(buildEmail(message).subject).toBe(subject);
  });

  it('text carries the fragment-carry link (#token=), the expiry statement, and the didn’t-request notice (REQ-3.1, D6)', () => {
    const { text } = buildEmail(message);
    expect(text).toContain(link);
    expect(link).toContain('#token=');
    expect(text).toContain(expiry);
    expect(text).toContain(notice);
  });

  it('html carries the same link (as the href), expiry statement, and notice', () => {
    const { html } = buildEmail(message);
    expect(html).toContain(`href="${link}"`);
    expect(html).toContain(expiry);
    expect(html).toContain(notice);
  });

  it('raw token appears nowhere but the link (REQ-3.9)', () => {
    const { subject: subj, text, html } = buildEmail(message);
    expect(subj).not.toContain(TOKEN);
    expect(text.split(link).join('')).not.toContain(TOKEN);
    expect(html.split(link).join('')).not.toContain(TOKEN);
  });

  it('html has no images, no tracking, no URL other than the link', () => {
    const { html } = buildEmail(message);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    // Strip the link (href + visible text) — no other http(s) reference may remain.
    expect(html.split(link).join('')).not.toContain('http');
  });
});

it('footer shows the instance host, never a hardcoded hosted domain (self-host de-brand)', () => {
  const { html } = buildEmail({ kind: 'password_reset', rawToken: TOKEN });
  expect(html).not.toContain('tradr.cloud');
  expect(html).toContain(new URL(BASE).host); // e.g. app.example.com
});

it('reads config.WEB_BASE_URL at call time, never captured at module load (Task 1 no-capture rule)', () => {
  config.WEB_BASE_URL = 'https://first.example.com';
  expect(buildEmail({ kind: 'password_reset', rawToken: TOKEN }).text).toContain(
    `https://first.example.com/reset-password#token=${TOKEN}`,
  );
  config.WEB_BASE_URL = 'https://second.example.com';
  expect(buildEmail({ kind: 'password_reset', rawToken: TOKEN }).text).toContain(
    `https://second.example.com/reset-password#token=${TOKEN}`,
  );
});

// data_export (Req 10.6): the token-free export notice — subject, the export
// instant in UTC and the change-password notice, with no token, link or image.
describe('buildEmail(data_export)', () => {
  const EXPORTED_AT = new Date('2026-09-26T14:37:53.284Z');
  const SUBJECT = 'Your Tradr data was exported';
  const NOTICE = 'If you did not do this, change your password now.';

  it('uses the pinned subject', () => {
    expect(buildEmail({ kind: 'data_export', exportedAt: EXPORTED_AT }).subject).toBe(SUBJECT);
  });

  it('text and html carry the export instant in UTC and the change-password notice', () => {
    const { text, html } = buildEmail({ kind: 'data_export', exportedAt: EXPORTED_AT });
    expect(text).toContain(EXPORTED_AT.toUTCString());
    expect(text).toContain(NOTICE);
    expect(html).toContain(EXPORTED_AT.toUTCString());
    expect(html).toContain(NOTICE);
  });

  it('carries no url and no image: no http anywhere, no <img>', () => {
    const { text, html } = buildEmail({ kind: 'data_export', exportedAt: EXPORTED_AT });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('http');
    expect(text).not.toContain('http');
  });
});

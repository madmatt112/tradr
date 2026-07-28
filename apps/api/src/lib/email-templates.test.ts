import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '@/lib/config';
import { buildEmail, type EmailKind } from '@/lib/email-templates';

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
  kind: EmailKind;
  subject: string;
  link: string;
  expiry: string;
  notice: string;
};

const PINS: Pin[] = [
  {
    kind: 'password_reset',
    subject: 'Reset your Tradr password',
    link: `${BASE}/reset-password#token=${TOKEN}`,
    expiry: 'This link expires in 60 minutes.',
    notice: "If you didn't request this, you can ignore this email — your password is unchanged.",
  },
  {
    kind: 'email_verification',
    subject: 'Verify your email address',
    link: `${BASE}/verify-email#token=${TOKEN}`,
    expiry: 'This link expires in 24 hours.',
    notice: "If you didn't request this, you can ignore this email.",
  },
];

describe.each(PINS)('buildEmail($kind)', ({ kind, subject, link, expiry, notice }) => {
  it('uses the pinned subject', () => {
    expect(buildEmail(kind, TOKEN).subject).toBe(subject);
  });

  it('text carries the fragment-carry link (#token=), the expiry statement, and the didn’t-request notice (REQ-3.1, D6)', () => {
    const { text } = buildEmail(kind, TOKEN);
    expect(text).toContain(link);
    expect(link).toContain('#token=');
    expect(text).toContain(expiry);
    expect(text).toContain(notice);
  });

  it('html carries the same link (as the href), expiry statement, and notice', () => {
    const { html } = buildEmail(kind, TOKEN);
    expect(html).toContain(`href="${link}"`);
    expect(html).toContain(expiry);
    expect(html).toContain(notice);
  });

  it('raw token appears nowhere but the link (REQ-3.9)', () => {
    const { subject: subj, text, html } = buildEmail(kind, TOKEN);
    expect(subj).not.toContain(TOKEN);
    expect(text.split(link).join('')).not.toContain(TOKEN);
    expect(html.split(link).join('')).not.toContain(TOKEN);
  });

  it('html has no images, no tracking, no URL other than the link', () => {
    const { html } = buildEmail(kind, TOKEN);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    // Strip the link (href + visible text) — no other http(s) reference may remain.
    expect(html.split(link).join('')).not.toContain('http');
  });
});

it('footer shows the instance host, never a hardcoded hosted domain (self-host de-brand)', () => {
  const { html } = buildEmail('password_reset', TOKEN);
  expect(html).not.toContain('tradr.cloud');
  expect(html).toContain(new URL(BASE).host); // e.g. app.example.com
});

it('reads config.WEB_BASE_URL at call time, never captured at module load (Task 1 no-capture rule)', () => {
  config.WEB_BASE_URL = 'https://first.example.com';
  expect(buildEmail('password_reset', TOKEN).text).toContain(
    `https://first.example.com/reset-password#token=${TOKEN}`,
  );
  config.WEB_BASE_URL = 'https://second.example.com';
  expect(buildEmail('password_reset', TOKEN).text).toContain(
    `https://second.example.com/reset-password#token=${TOKEN}`,
  );
});

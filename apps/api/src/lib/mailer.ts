// Mailer — the single SMTP transport and the delivery posture (design
// Component 2, D1/D9, REQ-2). Mirrors posthog.ts's graceful-absence shape:
// unconfigured ⇒ every function is a silent no-op. Delivery is best-effort,
// in-process, post-commit — no queue, no retry, no outbox. dispatchEmail
// returns void so no caller CAN await a send (REQ-2.7 enforced structurally);
// concurrency is bounded by MAX_IN_FLIGHT and shutdown loss is bounded by
// drainMailer's timeout. Log entries carry exactly `(event, { purpose,
// error })` — never the raw token, never the recipient address (REQ-2.5).

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { config, isEmailConfigured, type Config } from './config';
import { buildEmail, type EmailKind } from './email-templates';
import { logger } from './logger';
import { scrubString } from './telemetry-redact';

// Delivery-posture constants (D9, code constants like TELEMETRY_FLUSH_TIMEOUT_MS).
export const MAX_IN_FLIGHT = 5;
export const MAILER_DRAIN_TIMEOUT_MS = 5_000;

// A hung SMTP server bounds each send at well under a minute (REQ-2.4):
// connect 10 s, greeting 10 s, then 20 s of socket inactivity.
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

// `pool: false` is nodemailer's default but is pinned explicitly: the
// concurrency bound lives in THIS module, not in a pool's hidden queue (D1).
// SMTPTransport.Options carries no `pool` key (that lives on the pooled
// variant), hence the intersection.
export type MailerTransportOptions = SMTPTransport.Options & { pool: false };

/**
 * Pure config → nodemailer transport-options mapping, exported so the TLS-mode
 * and timeout mapping is unit-testable directly (MN-4 — the transportOverride
 * seam bypasses createTransport, making this mapping unobservable through it).
 * TLS modes: implicit → TLS from byte one; starttls → plaintext connect, then
 * a MANDATORY upgrade; none → plaintext throughout (Mailpit/local relays).
 */
export function buildTransportOptions(
  cfg: Pick<Config, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_TLS_MODE' | 'SMTP_USER' | 'SMTP_PASS'>,
): MailerTransportOptions {
  const tls =
    cfg.SMTP_TLS_MODE === 'implicit'
      ? { secure: true }
      : cfg.SMTP_TLS_MODE === 'none'
        ? { secure: false, ignoreTLS: true }
        : { secure: false, requireTLS: true }; // starttls — the default mode
  return {
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    pool: false,
    ...tls,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // The auth pair is optional (auth-less local relays); coherence — both or
    // neither — is enforced at boot by assertEmailConfigCoherence.
    ...(cfg.SMTP_USER && cfg.SMTP_PASS
      ? { auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } }
      : {}),
  };
}

// Module-level singleton (the posthog.ts `client` shape). Built by initMailer()
// only when configured; stays null otherwise, keeping dispatchEmail a no-op.
let transporter: Transporter | null = null;

// Every tracked send promise, from dispatch until settlement. Its size is the
// in-flight count for the MAX_IN_FLIGHT refusal and the drain snapshots.
const inFlight = new Set<Promise<void>>();

/**
 * Build the ONE non-pooled SMTP transport from config (D1). No-op unless
 * isEmailConfigured(). Deliberately NO transporter.verify() here: an SMTP
 * outage at boot must not fail startup — failures surface per-send (REQ-2.6).
 * The optional override is the unit-test seam only, never a production path.
 */
export function initMailer(transportOverride?: Transporter): void {
  if (!isEmailConfigured()) return;
  transporter = transportOverride ?? nodemailer.createTransport(buildTransportOptions(config));
}

/**
 * The ONLY send API (D9): fire-and-forget, returns void — callers cannot await
 * delivery (REQ-2.7). No-op when unconfigured or uninitialized. Refuses (and
 * logs) the send at the in-flight cap rather than queueing. The From header
 * uses nodemailer's escape-safe address-object form — never a formatted
 * string, where an unquoted comma/quote in the name would mis-parse (MN-4).
 * The mandatory .catch keeps a failed send from becoming an unhandled
 * rejection (Node dies on those); the log carries neither token nor address.
 */
export function dispatchEmail(kind: EmailKind, to: string, rawToken: string): void {
  if (!isEmailConfigured() || !transporter) return;
  if (inFlight.size >= MAX_IN_FLIGHT) {
    logger.warn('email_send_dropped_capacity', {
      purpose: kind,
      error: `in-flight cap (${MAX_IN_FLIGHT}) reached; send refused`,
    });
    return;
  }
  const { subject, text, html } = buildEmail(kind, rawToken);
  const send: Promise<void> = transporter
    .sendMail({
      from: { name: config.EMAIL_FROM_NAME ?? '', address: config.EMAIL_FROM! },
      to,
      subject,
      text,
      html,
    })
    .then(() => undefined)
    .catch((err: unknown) => {
      // scrubString masks email-shaped substrings: SMTP rejection messages
      // embed the recipient address (e.g. "550 <addr> rejected"), and the
      // stdout line — unlike the telemetry sink — has no redaction of its
      // own (REQ-2.5).
      logger.warn('email_send_failed', {
        purpose: kind,
        error: scrubString(err instanceof Error ? err.message : String(err)),
      });
    })
    .finally(() => {
      inFlight.delete(send);
    });
  inFlight.add(send);
}

/**
 * Resolve after `ms`. The dangling timer when the drain wins early is harmless
 * — shutdown ends in process.exit (the index.ts timeout precedent).
 */
function timeout(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort shutdown drain (D9, REQ-2.2): never rejects, resolves instantly
 * when idle, bounded by `timeoutMs`. RE-SNAPSHOTS the in-flight Set in a loop
 * — awaiting allSettled over the current snapshot and repeating while the Set
 * is non-empty and time remains — so a send dispatched between snapshots (by a
 * request already in flight when server.close() ran) is still caught. Tracked
 * promises never reject (mandatory .catch above), so nothing here can throw.
 * A send dispatched after the last snapshot the bound allows is lost at
 * process.exit — the named, accepted residual of the no-outbox posture.
 */
export async function drainMailer(timeoutMs = MAILER_DRAIN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await Promise.race([Promise.allSettled([...inFlight]), timeout(remaining)]);
  }
}

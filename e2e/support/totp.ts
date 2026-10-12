import crypto from 'node:crypto';

/**
 * A `node:crypto` TOTP generator for the two-factor e2e suite (design C2, D1).
 *
 * The browser flow needs to play the part of the user's authenticator app:
 * turn the base32 secret the enrolment screen shows into the six-digit code the
 * sign-in step expects. This mirrors the server's own RFC 6238 maths
 * (`apps/api/src/features/auth/totp.ts`) with an INDEPENDENT implementation, so
 * the test asserts the real contract rather than importing the code under test.
 *
 * RFC 6238 TOTP is HMAC-SHA-1 of the 30-second counter with RFC 4226 dynamic
 * truncation, reduced to six decimal digits. The helper's first use is a check
 * against the RFC 6238 Appendix B SHA-1 vector at T=59s (step 1 → "287082").
 */

// RFC 4648 base32 alphabet, no padding — the alphabet the enrolment secret uses.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

/**
 * RFC 4648 base32 decode (no padding, case-insensitive): turn the enrolment
 * secret string back into the raw bytes the TOTP HMAC keys on. Non-alphabet
 * characters are skipped, so a spaced or hyphenated secret still decodes.
 */
export function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of encoded.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/**
 * The TOTP value for a counter step: HMAC-SHA-1 of the step with RFC 4226
 * dynamic truncation, reduced to six decimal digits (left-padded).
 */
export function totpAt(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/** The current 30-second counter step for `nowMs` (defaults to now). */
export function currentStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / (TOTP_PERIOD_SECONDS * 1000));
}

/**
 * The TOTP code for the step `stepOffset` away from now. The server's verifier
 * accepts the window T-1..T+1 and rejects a step it has already consumed, so a
 * fresh sign-in after enrolment confirms with the current step passes a code one
 * step ahead (`stepOffset = 1`) to clear the replay guard.
 */
export function totpNow(secretBase32: string, stepOffset = 0, nowMs: number = Date.now()): string {
  return totpAt(secretBase32, currentStep(nowMs) + stepOffset);
}

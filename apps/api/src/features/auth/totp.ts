import crypto from 'node:crypto';

// TOTP and backup-code primitives (design C2, decision D1). Pure functions on
// node:crypto with no TOTP library, no database, logger or config import. RFC
// 6238 TOTP is HMAC-SHA-1 with dynamic truncation; backup codes are 50-bit
// strings hashed with SHA-256 (decision D12). Never log an input here.

// RFC 4648 base32 alphabet (no padding). Uppercase for the TOTP secret URI,
// lowercased for backup codes.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const SECRET_BYTES = 20; // RFC 6238 recommends a 160-bit SHA-1 secret (Req 1.2).
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_CHARS = 10; // 10 base32 characters -> 50 bits (decision D12).

/** 20 random bytes — a fresh SHA-1 TOTP secret (Req 1.2). */
export function generateTotpSecret(): Buffer {
  return crypto.randomBytes(SECRET_BYTES);
}

/** RFC 4648 base32, no padding. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * RFC 4648 base32 decode (no padding, case-insensitive): the inverse of
 * `base32Encode`, turning a stored secret string back into the raw bytes the
 * TOTP HMAC keys on (design C2). Non-alphabet characters are skipped, so a
 * hyphen- or space-separated secret still decodes.
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
 * dynamic truncation, reduced to 6 decimal digits (left-padded).
 */
export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = bin % 10 ** TOTP_DIGITS;
  return otp.toString().padStart(TOTP_DIGITS, '0');
}

/** Constant-time string compare that tolerates unequal lengths. */
function codesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Match a submitted TOTP code against the ±1 step window around now, rejecting
 * replays. Tries steps T-1, T, T+1 (T = floor(nowMs / 30000)) with a
 * constant-time compare, and returns the matched step only when it exceeds
 * `lastUsedStep` (Req 1.3, design C2); otherwise null.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastUsedStep?: number | null,
): number | null {
  const current = Math.floor(nowMs / (TOTP_PERIOD_SECONDS * 1000));
  const floor = lastUsedStep ?? Number.NEGATIVE_INFINITY;
  for (const step of [current - 1, current, current + 1]) {
    if (step > floor && codesMatch(totpAt(secret, step), code)) {
      return step;
    }
  }
  return null;
}

/**
 * The `otpauth://` provisioning URI an authenticator app consumes: label
 * `Tradr:<email>`, issuer Tradr, SHA1, 6 digits, 30-second period (design C2).
 */
export function otpauthUri(secretBase32: string, email: string): string {
  const label = `Tradr:${encodeURIComponent(email)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: 'Tradr',
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Ten distinct backup codes, each ten lowercase base32 characters shown as two
 * groups of five joined by a hyphen (design C2/D12).
 */
export function generateBackupCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) {
    let raw = '';
    for (let i = 0; i < BACKUP_CODE_CHARS; i++) {
      raw += BASE32_ALPHABET[crypto.randomInt(BASE32_ALPHABET.length)].toLowerCase();
    }
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/**
 * The stored hash of a backup code: SHA-256 hex of the code lowercased and
 * stripped of non-alphanumerics, so hyphen and case variants hash equally
 * (design C2/D12).
 */
export function hashBackupCode(code: string): string {
  const canonical = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

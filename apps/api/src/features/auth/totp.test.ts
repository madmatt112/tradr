import { describe, it, expect } from 'vitest';

import {
  totpAt,
  matchTotp,
  base32Encode,
  otpauthUri,
  generateBackupCodes,
  hashBackupCode,
} from './totp';

// RFC 6238 Appendix B's shared ASCII secret, 20 bytes.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

// The RFC 4648 (no padding) base32 encoding of RFC_SECRET, computed
// independently with a standalone base32 encoder/decoder (not the module
// under test): see /tmp/scratchpad/sdd/security-hardening/probe-base32.mjs.
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Independent RFC 4648 base32 decoder, used only to prove base32Encode's
// output round-trips — never imported from the module under test.
function base32Decode(str: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of str.toUpperCase()) {
    const idx = RFC4648_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describe('totpAt', () => {
  /**
   * Contract:
   * - Pre-condition: RFC_SECRET is the RFC 6238 Appendix B ASCII secret.
   * - Test: totpAt(RFC_SECRET, step) for each of the six Appendix B SHA-1
   *   vectors' steps.
   * - Observable result: the last six digits of each vector's 8-digit value.
   * - Source of expected value: RFC 6238 Appendix B SHA-1 vectors, reduced
   *   to their last six digits (e.g. T=59 -> 94287082 -> "287082"), each
   *   reproduced independently with node:crypto HMAC-SHA1 dynamic
   *   truncation — see /tmp/scratchpad/sdd/security-hardening/probe-totp.mjs,
   *   run 2026-10-09, output: 1 287082 / 37037036 081804 / 37037037 050471 /
   *   41152263 005924 / 66666666 279037 / 666666666 353130.
   */
  it('matches all six RFC 6238 Appendix B SHA-1 vectors', () => {
    const vectors: Array<[number, string]> = [
      [1, '287082'],
      [37037036, '081804'],
      [37037037, '050471'],
      [41152263, '005924'],
      [66666666, '279037'],
      [666666666, '353130'],
    ];

    for (const [step, expected] of vectors) {
      expect(totpAt(RFC_SECRET, step)).toBe(expected);
    }
  });
});

describe('matchTotp', () => {
  /**
   * Contract:
   * - Pre-condition: a fixed secret and a step T with nowMs set mid-step
   *   (T * 30000 + 10000), so floor(nowMs / 30000) === T.
   * - Test: matchTotp(secret, code, nowMs, null) for codes generated at
   *   T-1, T, T+1 and T+2.
   * - Observable result: T-1/T/T+1 codes each return their own step number;
   *   the T+2 code (two steps away) returns null.
   * - Source of expected value: design C2's window definition — matchTotp
   *   "tries steps T-1, T, T+1" — so only those three codes can match.
   */
  it('matches a code from the previous or next step and rejects one two steps away', () => {
    const T = 1_000_000;
    const nowMs = T * 30_000 + 10_000;

    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, T - 1), nowMs, null)).toBe(T - 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, T), nowMs, null)).toBe(T);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, T + 1), nowMs, null)).toBe(T + 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, T + 2), nowMs, null)).toBeNull();
  });

  /**
   * Contract:
   * - Pre-condition: a fixed secret and step T with nowMs mid-step, and
   *   lastUsedStep already set to T (that step was accepted once before).
   * - Test: matchTotp(secret, totpAt(secret, T), nowMs, T).
   * - Observable result: null — a step that does not exceed lastUsedStep
   *   is a replay and is rejected even though the code itself is correct.
   * - Source of expected value: design C2 — matchTotp "returns the matched
   *   step only when it exceeds lastUsedStep" (Req 1.3, design D10).
   */
  it('rejects a replayed step that does not exceed lastUsedStep', () => {
    const T = 2_000_000;
    const nowMs = T * 30_000 + 10_000;
    const code = totpAt(RFC_SECRET, T);

    expect(matchTotp(RFC_SECRET, code, nowMs, T)).toBeNull();
  });
});

describe('base32Encode', () => {
  /**
   * Contract:
   * - Pre-condition: RFC_SECRET, the RFC 6238 Appendix B ASCII secret.
   * - Test: base32Encode(RFC_SECRET).
   * - Observable result: equals RFC_SECRET_BASE32, and independently
   *   base32-decoding that string (with a decoder outside the module under
   *   test) reproduces RFC_SECRET's bytes exactly.
   * - Source of expected value: RFC 4648 base32 (no padding) applied to
   *   RFC_SECRET, computed independently — see
   *   /tmp/scratchpad/sdd/security-hardening/probe-base32.mjs, run
   *   2026-10-09, output "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", decode
   *   round-trip true.
   */
  it('encodes the RFC secret to RFC 4648 base32 and round-trips', () => {
    const encoded = base32Encode(RFC_SECRET);

    expect(encoded).toBe(RFC_SECRET_BASE32);
    expect(base32Decode(encoded)).toEqual(RFC_SECRET);
  });
});

describe('otpauthUri', () => {
  /**
   * Contract:
   * - Pre-condition: a base32 secret and a user email address.
   * - Test: otpauthUri(RFC_SECRET_BASE32, 'user@example.com').
   * - Observable result: parsing the result as a URL gives scheme
   *   "otpauth:", host "totp", a path beginning "/Tradr:", and query
   *   parameters secret=<the base32 secret>, issuer=Tradr,
   *   algorithm=SHA1, digits=6, period=30.
   * - Source of expected value: design C2 — "otpauth://totp/Tradr: plus
   *   the encoded address, secret, issuer=Tradr, algorithm=SHA1,
   *   digits=6, period=30".
   */
  it('carries issuer Tradr, algorithm SHA1, 6 digits and a 30-second period', () => {
    const uri = otpauthUri(RFC_SECRET_BASE32, 'user@example.com');
    const parsed = new URL(uri);

    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.host).toBe('totp');
    expect(parsed.pathname.startsWith('/Tradr:')).toBe(true);
    expect(parsed.searchParams.get('secret')).toBe(RFC_SECRET_BASE32);
    expect(parsed.searchParams.get('issuer')).toBe('Tradr');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });
});

describe('generateBackupCodes', () => {
  /**
   * Contract:
   * - Pre-condition: none — generateBackupCodes() takes no arguments.
   * - Test: generateBackupCodes().
   * - Observable result: an array of 10 distinct strings, each matching
   *   two groups of 5 lowercase base32 characters joined by a hyphen.
   * - Source of expected value: design C2 — "10 codes of 10 lowercase
   *   base32 characters, shown as two groups of 5 joined by -".
   */
  it('generates 10 distinct codes shaped as two lowercase base32 groups of 5', () => {
    const codes = generateBackupCodes();

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    }
  });
});

describe('hashBackupCode', () => {
  /**
   * Contract:
   * - Pre-condition: two differently-formatted renderings of the same
   *   backup code: 'ABCDE-fghij' (uppercase group, hyphen) and
   *   'abcdefghij' (fully lowercase, no hyphen).
   * - Test: hashBackupCode('ABCDE-fghij') and hashBackupCode('abcdefghij').
   * - Observable result: the two hashes are equal, and each is a 64-char
   *   lowercase hex string.
   * - Source of expected value: design C2/D12 — hashBackupCode is "SHA-256
   *   hex after lowercasing and removing non-alphanumerics", so both
   *   inputs reduce to the same canonical string "abcdefghij" before
   *   hashing.
   */
  it('hashes case- and hyphen-variant renderings of the same code equally', () => {
    const a = hashBackupCode('ABCDE-fghij');
    const b = hashBackupCode('abcdefghij');

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

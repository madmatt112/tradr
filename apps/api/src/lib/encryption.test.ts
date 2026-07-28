import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decrypt,
  encrypt,
  EncryptionError,
  ENCRYPTION_KEY_VERSION_CURRENT,
  loadEncryptionKeyMaterial,
  runEncryptionFingerprintCheckIfConfigured,
} from './encryption';

const CURRENT_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const PREVIOUS_KEY = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

function fingerprintOf(hexKey: string): string {
  return createHash('sha256').update(Buffer.from(hexKey, 'hex')).digest('hex');
}

describe('encryption', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', CURRENT_KEY);
    loadEncryptionKeyMaterial();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('round-trips an arbitrary string', () => {
    const plaintext = 'sk-secret-value-with-üñîçødé-😀';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('round-trips a 1 MB payload', () => {
    const plaintext = 'a'.repeat(1024 * 1024);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('rejects a tampered envelope with gcm-tag-mismatch', () => {
    const buf = Buffer.from(encrypt('tamper me'), 'base64');
    // Flip a bit in the ciphertext region (past version + iv).
    buf[buf.length - 17] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow(EncryptionError);
    expect(() => decrypt(tampered)).toThrowError(
      expect.objectContaining({ reason: 'gcm-tag-mismatch' }),
    );
  });

  it('rejects an unknown version with unknown-version', () => {
    const buf = Buffer.from(encrypt('versioned'), 'base64');
    buf[0] = 0x7f; // unregistered version, still long enough to pass length check
    expect(() => decrypt(buf.toString('base64'))).toThrowError(
      expect.objectContaining({ reason: 'unknown-version' }),
    );
  });

  it('rejects a truncated envelope with malformed-envelope', () => {
    const truncated = Buffer.from([ENCRYPTION_KEY_VERSION_CURRENT, 0x00, 0x01]).toString('base64');
    expect(() => decrypt(truncated)).toThrowError(
      expect.objectContaining({ reason: 'malformed-envelope' }),
    );
  });

  it('decrypts via previous key after rotation', () => {
    // Encrypt under the previous key, then rotate: previous becomes the fallback.
    vi.stubEnv('ENCRYPTION_KEY', PREVIOUS_KEY);
    loadEncryptionKeyMaterial();
    const envelope = encrypt('rotated secret');

    vi.stubEnv('ENCRYPTION_KEY', CURRENT_KEY);
    vi.stubEnv('ENCRYPTION_KEY_PREVIOUS', PREVIOUS_KEY);
    loadEncryptionKeyMaterial();

    expect(decrypt(envelope)).toBe('rotated secret');
  });

  it('calls process.exit(1) on fingerprint mismatch and is a no-op on match', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    vi.stubEnv('ENCRYPTION_KEY_FINGERPRINT', 'f'.repeat(64));
    runEncryptionFingerprintCheckIfConfigured();
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockClear();
    vi.stubEnv('ENCRYPTION_KEY_FINGERPRINT', fingerprintOf(CURRENT_KEY));
    runEncryptionFingerprintCheckIfConfigured();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when the fingerprint env is unset', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.stubEnv('ENCRYPTION_KEY_FINGERPRINT', undefined);
    runEncryptionFingerprintCheckIfConfigured();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

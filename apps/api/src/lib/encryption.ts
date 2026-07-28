import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { envSchema } from './config';
import { logger } from './logger';

/**
 * AES-256-GCM BYOK encryption utility (design §Component 1, REQ-5.1 / REQ-5.3).
 *
 * Envelope layout (binary, then base64-encoded):
 *   [ version (1 byte) | iv (12 bytes) | ciphertext (N bytes) | tag (16 bytes) ]
 *
 * Threat model and rotation semantics are documented in design §Component 1.
 * Key rotation requires a process restart — keys are cached at bootstrap.
 */

export const ENCRYPTION_KEY_VERSION_CURRENT = 0x01;

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION_LENGTH = 1;
const MIN_ENVELOPE_LENGTH = VERSION_LENGTH + IV_LENGTH + TAG_LENGTH; // 29

type EncryptionErrorReason = 'unknown-version' | 'gcm-tag-mismatch' | 'malformed-envelope';

export class EncryptionError extends Error {
  readonly reason: EncryptionErrorReason;

  constructor(reason: EncryptionErrorReason, cause?: Error) {
    super(`Encryption error: ${reason}`);
    this.name = 'EncryptionError';
    this.reason = reason;
    if (cause) (this as Error & { cause?: Error }).cause = cause;
  }
}

// Module-level key material. Loaded eagerly at bootstrap via loadEncryptionKeyMaterial().
let currentKey: Buffer | null = null;
let previousKey: Buffer | null = null;

function getCurrentKey(): Buffer {
  if (!currentKey) {
    throw new Error(
      'encryption: key material not loaded — call loadEncryptionKeyMaterial() at bootstrap',
    );
  }
  return currentKey;
}

// --- Per-version handler registry (design §Component 1, v2-12 forward-compat) ---

interface VersionHandler {
  encrypt(plaintext: string): Buffer;
  decrypt(body: Buffer): string;
}

function encryptV01(plaintext: string): Buffer {
  const key = getCurrentKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([ENCRYPTION_KEY_VERSION_CURRENT]), iv, ciphertext, tag]);
}

function decryptV01WithKey(key: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decryptV01(body: Buffer): string {
  // body excludes the version byte: [ iv | ciphertext | tag ]
  const iv = body.subarray(0, IV_LENGTH);
  const tag = body.subarray(body.length - TAG_LENGTH);
  const ciphertext = body.subarray(IV_LENGTH, body.length - TAG_LENGTH);

  // Resolve keys BEFORE the try so a missing-key/boot-ordering error surfaces
  // as its own error rather than being masked as 'gcm-tag-mismatch'.
  const key = getCurrentKey();
  const prevKey = previousKey;

  try {
    return decryptV01WithKey(key, iv, ciphertext, tag);
  } catch (currentErr) {
    if (prevKey) {
      try {
        return decryptV01WithKey(prevKey, iv, ciphertext, tag);
      } catch (previousErr) {
        throw new EncryptionError('gcm-tag-mismatch', previousErr as Error);
      }
    }
    throw new EncryptionError('gcm-tag-mismatch', currentErr as Error);
  }
}

const versionHandlers: Record<number, VersionHandler> = {
  [ENCRYPTION_KEY_VERSION_CURRENT]: { encrypt: encryptV01, decrypt: decryptV01 },
};

// --- Public API ---

export function encrypt(plaintext: string): string {
  const handler = versionHandlers[ENCRYPTION_KEY_VERSION_CURRENT];
  return handler.encrypt(plaintext).toString('base64');
}

export function decrypt(envelope: string): string {
  const buf = Buffer.from(envelope, 'base64');
  if (buf.length < MIN_ENVELOPE_LENGTH) {
    throw new EncryptionError('malformed-envelope');
  }
  const version = buf[0];
  const handler = versionHandlers[version];
  if (!handler) {
    throw new EncryptionError('unknown-version');
  }
  return handler.decrypt(buf.subarray(VERSION_LENGTH));
}

// --- Bootstrap key loading + fingerprint check (design §Component 1, bootstrap steps 2-3) ---

/**
 * Eagerly load key material from env into module-level state. Called from bootstrap()
 * BEFORE the HTTP listener opens (and before migrations, per v4-8). The config Zod
 * schema already rejects malformed lengths; this only hex-decodes and caches.
 */
export function loadEncryptionKeyMaterial(): void {
  // Re-parse process.env at call time (not the cached `config`): bootstrap calls this
  // before the listener opens, and tests drive it via vi.stubEnv between calls.
  // eslint-disable-next-line no-restricted-syntax
  const env = envSchema.parse(process.env);
  currentKey = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  previousKey = env.ENCRYPTION_KEY_PREVIOUS
    ? Buffer.from(env.ENCRYPTION_KEY_PREVIOUS, 'hex')
    : null;
}

/**
 * If ENCRYPTION_KEY_FINGERPRINT is set, assert sha256(loadedKeyBytes) matches.
 * On mismatch: log at error level and process.exit(1). No-op when unset (v4-3).
 */
export function runEncryptionFingerprintCheckIfConfigured(): void {
  // eslint-disable-next-line no-restricted-syntax
  const env = envSchema.parse(process.env);
  const expected = env.ENCRYPTION_KEY_FINGERPRINT;
  if (!expected) return;

  const actual = createHash('sha256').update(getCurrentKey()).digest('hex');
  if (actual !== expected) {
    logger.error('Encryption key fingerprint mismatch', {
      event: 'encryption_fingerprint_mismatch',
      expected,
      actual,
    });
    process.exit(1);
  }
}

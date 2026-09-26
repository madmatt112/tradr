import type { AccountDataErrorCode } from '@tradr/shared';
import { ARCHIVE_VERSION } from '@tradr/shared';

import { AppError, ValidationError } from '@/lib/errors';

/**
 * Error classes for the account export/import slice (design C9 Routes and
 * errors). Every code comes from `ACCOUNT_DATA_ERROR_CODES` (the frozen contract
 * in `@tradr/shared`); the `satisfies AccountDataErrorCode` annotation ties each
 * literal to that constant so a typo fails the build. `OBJECT_UNREACHABLE` (503)
 * and `RATE_LIMITED` (429) already exist and are raised by their own classes.
 */

/**
 * The manifest declares an archive version above the one this server reads
 * (design Error Handling, 400). The message names both versions.
 */
export class ArchiveVersionUnsupportedError extends AppError {
  constructor(public foundVersion: number) {
    super(
      400,
      'ARCHIVE_VERSION_UNSUPPORTED' satisfies AccountDataErrorCode,
      `Archive version ${foundVersion} is not supported; this server reads version ${ARCHIVE_VERSION}.`,
    );
  }
}

/**
 * Any container, schema, reference, invariant or count fault (design Error
 * Handling, 400). It extends `ValidationError` and overrides `code` so
 * `error.middleware.ts` renders its `fields` array; at most 50 faults are kept.
 */
export class ArchiveInvalidError extends ValidationError {
  constructor(
    fields: Array<{ path: string; code: string; message: string }>,
    message = 'The archive is not valid.',
  ) {
    super(message, undefined, fields.slice(0, 50));
    this.code = 'ARCHIVE_INVALID' satisfies AccountDataErrorCode;
  }
}

/**
 * The archive carries no row in any blocking category (design Error Handling,
 * 400).
 */
export class ArchiveEmptyError extends AppError {
  constructor() {
    super(
      400,
      'ARCHIVE_EMPTY' satisfies AccountDataErrorCode,
      'The archive contains no importable rows.',
    );
  }
}

/**
 * Confirm bytes differ from the archive the preview digested (design Error
 * Handling, 400).
 */
export class ArchiveDigestMismatchError extends AppError {
  constructor() {
    super(
      400,
      'ARCHIVE_DIGEST_MISMATCH' satisfies AccountDataErrorCode,
      'The uploaded archive does not match the previewed archive; preview it again.',
    );
  }
}

/**
 * The target account already holds data at preview or the in-transaction
 * re-check (design Error Handling, 409). The message names the categories.
 */
export class ImportTargetNotEmptyError extends AppError {
  constructor(public categories: string[]) {
    super(
      409,
      'IMPORT_TARGET_NOT_EMPTY' satisfies AccountDataErrorCode,
      `The account already has data (${categories.join(', ')}); import needs an empty account.`,
    );
  }
}

/**
 * The upload exceeded a cap (design Error Handling, 413). The message names the
 * cap and its value.
 */
export class ArchiveTooLargeError extends AppError {
  constructor(
    public cap: string,
    public limit: number,
  ) {
    super(
      413,
      'ARCHIVE_TOO_LARGE' satisfies AccountDataErrorCode,
      `Archive exceeds the ${cap} limit of ${limit} bytes.`,
    );
  }
}

/**
 * The restore rolled back on an unexpected error (design Error Handling, 500).
 * Logged with the request id by the error middleware.
 */
export class ImportFailedError extends AppError {
  constructor(message = 'The import failed and was rolled back.') {
    super(500, 'IMPORT_FAILED' satisfies AccountDataErrorCode, message);
  }
}

/**
 * A lock acquisition inside the restore transaction exceeded its budget (design
 * Error Handling, 503); the client should retry shortly.
 */
export class ImportBusyError extends AppError {
  constructor() {
    super(
      503,
      'IMPORT_BUSY' satisfies AccountDataErrorCode,
      'The account is busy with another data operation; retry shortly.',
    );
  }
}

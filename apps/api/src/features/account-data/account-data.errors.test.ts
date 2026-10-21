import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

import { ImportCapacityError, ImportTimedOutError } from './account-data.errors';

describe('account-data.errors new codes (design C6, Requirements 2.2, 3.2)', () => {
  it('ImportTimedOutError is a 422 IMPORT_TIMED_OUT with the design C6 message', () => {
    const error = new ImportTimedOutError();
    expect(error).toBeInstanceOf(AppError);
    expect([error.statusCode, error.code, error.message]).toEqual([
      422,
      'IMPORT_TIMED_OUT',
      'The archive took too long to process and nothing was imported. Try again later; if it keeps happening, the archive is too large for this server.',
    ]);
  });

  it('ImportCapacityError is a 503 IMPORT_CAPACITY_REACHED with the design C6 message', () => {
    const error = new ImportCapacityError();
    expect(error).toBeInstanceOf(AppError);
    expect([error.statusCode, error.code, error.message]).toEqual([
      503,
      'IMPORT_CAPACITY_REACHED',
      'The server is already processing another import. Your account is not affected; wait a few minutes and try again.',
    ]);
  });
});

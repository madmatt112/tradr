import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

import {
  InvariantViolationError,
  ProviderErrorError,
  ProviderKeyRejectedError,
  ProviderRateLimitedError,
  ProviderUnavailableError,
  StreamInProgressError,
  mapProviderError,
} from './advisor.errors';

describe('advisor.errors', () => {
  it('subclasses extend AppError with the REQ-3.15 code + status', () => {
    const rejected = new ProviderKeyRejectedError(401);
    expect(rejected).toBeInstanceOf(AppError);
    expect([rejected.code, rejected.statusCode, rejected.upstreamStatus]).toEqual([
      'PROVIDER_KEY_REJECTED',
      400,
      401,
    ]);

    const inProgress = new StreamInProgressError();
    expect(inProgress).toBeInstanceOf(AppError);
    expect([inProgress.code, inProgress.statusCode]).toEqual(['STREAM_IN_PROGRESS', 429]);

    const invariant = new InvariantViolationError('nope');
    expect(invariant).toBeInstanceOf(AppError);
    expect(invariant.code).toBe('INVARIANT_VIOLATION');
  });

  it('mapProviderError maps provider HTTP statuses to the right class', () => {
    expect(mapProviderError({ status: 403 })).toBeInstanceOf(ProviderKeyRejectedError);
    expect(mapProviderError({ status: 429 })).toBeInstanceOf(ProviderRateLimitedError);
    expect(mapProviderError({ status: 503 })).toBeInstanceOf(ProviderUnavailableError);

    const rateLimited = mapProviderError({ status: 429 }) as ProviderRateLimitedError;
    expect(rateLimited.upstreamStatus).toBe(429);
  });

  it('mapProviderError falls back to PROVIDER_ERROR with null upstreamStatus on network/unknown errors', () => {
    const fromNetwork = mapProviderError(new Error('ECONNRESET')) as ProviderErrorError;
    expect(fromNetwork).toBeInstanceOf(ProviderErrorError);
    expect(fromNetwork.upstreamStatus).toBeNull();

    const fromOddStatus = mapProviderError({ status: 418 }) as ProviderErrorError;
    expect(fromOddStatus).toBeInstanceOf(ProviderErrorError);
    expect(fromOddStatus.upstreamStatus).toBeNull();
  });
});

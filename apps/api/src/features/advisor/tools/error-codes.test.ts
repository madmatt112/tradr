import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

import {
  ConversationTurnTooLargeError,
  DegenerateToolFailureError,
  ToolLoopExhaustedError,
} from '../advisor.errors';

import { EVENT_ERROR_CODES, NOTICE_CODES, TOOL_RESULT_CODES, bucketOf } from './error-codes';

describe('tools/error-codes taxonomy (REQ-15)', () => {
  it('classifies every tool_result code as the continue bucket', () => {
    for (const code of Object.values(TOOL_RESULT_CODES)) {
      expect(bucketOf(code)).toBe('tool_result');
    }
  });

  it('classifies every notice code as the notice bucket', () => {
    for (const code of Object.values(NOTICE_CODES)) {
      expect(bucketOf(code)).toBe('notice');
    }
  });

  it('classifies every event:error code as the terminate bucket', () => {
    for (const code of Object.values(EVENT_ERROR_CODES)) {
      expect(bucketOf(code)).toBe('event_error');
    }
  });

  it('covers exactly the codes named in REQ-15.2', () => {
    expect(Object.values(TOOL_RESULT_CODES).sort()).toEqual(
      [
        'MARKET_DATA_KEY_INVALID',
        'MARKET_DATA_RATE_LIMITED',
        'MARKET_DATA_UNAVAILABLE',
        'PLATFORM_RATE_LIMITED',
        'SYMBOL_NOT_FOUND',
        'TOOL_INPUT_INVALID',
        'TOOL_NOT_PERMITTED',
        'TOOL_TIMEOUT',
        'TRADE_DATA_BUDGET_EXCEEDED',
      ].sort(),
    );
    expect(Object.values(NOTICE_CODES).sort()).toEqual(
      ['answer_incomplete', 'summarized', 'summary_failed'].sort(),
    );
  });

  it('keeps platform and upstream rate-limit codes distinct (REQ-15.4)', () => {
    expect(TOOL_RESULT_CODES.PLATFORM_RATE_LIMITED).not.toBe(
      TOOL_RESULT_CODES.MARKET_DATA_RATE_LIMITED,
    );
    expect(bucketOf('PLATFORM_RATE_LIMITED')).toBe('tool_result');
    expect(bucketOf('MARKET_DATA_RATE_LIMITED')).toBe('tool_result');
  });

  it('classifies the unchanged advisor-core terminating codes (bucketOf is total)', () => {
    for (const code of [
      'PROVIDER_CONNECT_TIMEOUT',
      'PROVIDER_INACTIVITY_TIMEOUT',
      'STREAM_TIMEOUT',
      'PROVIDER_ERROR',
      'PERSISTENCE_FAILED',
    ]) {
      expect(bucketOf(code)).toBe('event_error');
    }
  });

  it('throws on an unknown code so new codes cannot slip the fork', () => {
    expect(() => bucketOf('NOT_A_REAL_CODE')).toThrow();
  });
});

describe('tool-loop terminating errors emit in the event:error shape', () => {
  // Mirrors streaming.ts: frame('error', { code, upstreamStatus }) for
  // STREAM_TIMEOUT-style codes. Each terminating error is an AppError carrying a
  // stable `code` that bucketOf classifies as event_error.
  const cases = [
    { make: () => new ToolLoopExhaustedError(), code: 'TOOL_LOOP_EXHAUSTED' },
    { make: () => new DegenerateToolFailureError(), code: 'DEGENERATE_TOOL_FAILURE' },
    { make: () => new ConversationTurnTooLargeError(), code: 'CONVERSATION_TURN_TOO_LARGE' },
  ];

  for (const { make, code } of cases) {
    it(`${code} is an AppError whose code buckets as event_error`, () => {
      const err = make();
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe(code);
      expect(bucketOf(err.code)).toBe('event_error');

      // The advisor-core event:error frame payload shape (streaming.ts).
      const payload = { code: err.code, upstreamStatus: null };
      expect(payload).toEqual({ code, upstreamStatus: null });
    });
  }
});

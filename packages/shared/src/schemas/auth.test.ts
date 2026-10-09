import { describe, expect, it } from 'vitest';

import {
  LoginTwoFactorSchema,
  TwoFactorCodeSchema,
  TwoFactorDisableSchema,
  UnlockAccountSchema,
} from './auth';

// Contract (design C8; task 2 Success line; Req 2.2, 2.4, 2.9, 1.7, 1.8, 4.9):
//
// - LoginTwoFactorSchema.safeParse — pre: a 64-char lowercase-hex challenge and
//   a 6-digit code. Call: LoginTwoFactorSchema.safeParse({ challenge, code }).
//   Observed: result.success === true. Expected value source: design C8's
//   `{ challenge: TokenField; code: trimmed string, 6-20 chars }` and the task
//   prompt's "a valid challenge and a 6-digit code parse".
// - LoginTwoFactorSchema.safeParse — pre: a valid challenge, a 5-character
//   code. Call: same. Observed: result.success === false. Source: prompt's
//   "a 5-character code … fail[s]" (code is 6-20 chars).
// - LoginTwoFactorSchema.safeParse — pre: a valid challenge, a 21-character
//   code. Call: same. Observed: result.success === false. Source: prompt's
//   "a 21-character code … fail[s]".
// - LoginTwoFactorSchema.safeParse — pre: a 64-character challenge containing
//   a non-hex character, a valid code. Call: same. Observed:
//   result.success === false. Source: TokenField's regex
//   /^[0-9a-f]{64}$/ (packages/shared/src/schemas/auth.ts:13) and the
//   prompt's "a non-hex challenge fail[s]".
// - LoginTwoFactorSchema.safeParse / TwoFactorCodeSchema.safeParse — pre: a
//   code padded with surrounding whitespace that is 6-20 chars once trimmed.
//   Call: same. Observed: result.success === true and the parsed code equals
//   the trimmed value. Source: prompt's "code": trimmed string, 6-20
//   characters" and "whitespace around a code is trimmed".
// - TwoFactorDisableSchema.safeParse — pre: a body missing `password` or
//   missing `code`. Call: TwoFactorDisableSchema.safeParse(body). Observed:
//   result.success === false for each omission. Source: design C8's
//   `TwoFactorDisableSchema { password: PasswordField; code }` and the
//   prompt's "disable needs both fields".
// - UnlockAccountSchema.safeParse — pre: a 63-character token. Call:
//   UnlockAccountSchema.safeParse({ token }). Observed:
//   result.success === false. Source: TokenField's 64-char rule and the
//   prompt's "unlock rejects a 63-character token".

const VALID_CHALLENGE = 'a'.repeat(64);
const VALID_CODE = '123456';

describe('LoginTwoFactorSchema', () => {
  it('parses a valid challenge plus a 6-digit code', () => {
    const result = LoginTwoFactorSchema.safeParse({
      challenge: VALID_CHALLENGE,
      code: VALID_CODE,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a 5-character code', () => {
    const result = LoginTwoFactorSchema.safeParse({
      challenge: VALID_CHALLENGE,
      code: '12345',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a 21-character code', () => {
    const result = LoginTwoFactorSchema.safeParse({
      challenge: VALID_CHALLENGE,
      code: 'a'.repeat(21),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-hex challenge', () => {
    const result = LoginTwoFactorSchema.safeParse({
      challenge: 'g'.repeat(64),
      code: VALID_CODE,
    });
    expect(result.success).toBe(false);
  });
});

describe('TwoFactorCodeSchema', () => {
  it('trims surrounding whitespace from the code', () => {
    const result = TwoFactorCodeSchema.safeParse({ code: `  ${VALID_CODE}  ` });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.code).toBe(VALID_CODE);
  });
});

describe('TwoFactorDisableSchema', () => {
  it.each([
    ['password', { code: VALID_CODE }],
    ['code', { password: 'correct-horse' }],
  ])('fails when %s is missing', (_field, body) => {
    const result = TwoFactorDisableSchema.safeParse(body);
    expect(result.success).toBe(false);
  });
});

describe('UnlockAccountSchema', () => {
  it('rejects a 63-character token', () => {
    const result = UnlockAccountSchema.safeParse({ token: 'a'.repeat(63) });
    expect(result.success).toBe(false);
  });
});

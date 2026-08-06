import { describe, expect, it } from 'vitest';

import { RegisterSchema } from './auth';
import { UserTimezoneSchema } from './user';

const baseRegister = { email: 'trader@example.com', password: 'correct-horse' };

describe('UserTimezoneSchema', () => {
  it.each(['America/New_York', 'Asia/Tokyo', 'Europe/London', 'Australia/Sydney', 'Pacific/Apia'])(
    'accepts %s',
    (tz) => {
      const result = UserTimezoneSchema.safeParse({ timezone: tz });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.timezone).toBe(tz);
    },
  );

  // The whole reason validation goes through resolveTimezone rather than
  // IANA_TIMEZONES.includes(): Intl.supportedValuesOf('timeZone') omits every
  // Etc/* zone and bare UTC, all of which are real zones a client may send.
  it.each(['UTC', 'Etc/UTC', 'Etc/GMT', 'Etc/GMT+5', 'Etc/GMT-9'])(
    'accepts %s even though the picker list omits it',
    (tz) => {
      expect(UserTimezoneSchema.safeParse({ timezone: tz }).success).toBe(true);
    },
  );

  // Intl silently strips Unicode extensions, so `America/New_York-u-ca-japanese`
  // would otherwise resolve and be stored verbatim. resolveTimezone rejects it.
  it.each(['America/New_York-u-ca-japanese', 'UTC-u-ca-buddhist'])(
    'rejects the Unicode-extension bypass %s',
    (tz) => {
      expect(UserTimezoneSchema.safeParse({ timezone: tz }).success).toBe(false);
    },
  );

  it.each(['Not/AZone', 'America/Nowhere', 'EST5EDT5', 'abc', '../../etc/passwd'])(
    'rejects junk %s',
    (tz) => {
      expect(UserTimezoneSchema.safeParse({ timezone: tz }).success).toBe(false);
    },
  );

  it('rejects an empty string', () => {
    expect(UserTimezoneSchema.safeParse({ timezone: '' }).success).toBe(false);
  });

  // Bounded to the users.timezone varchar(64) column.
  it('rejects a string longer than the 64-char column', () => {
    expect(UserTimezoneSchema.safeParse({ timezone: 'A'.repeat(65) }).success).toBe(false);
  });

  it('reports the failure on the timezone field', () => {
    const result = UserTimezoneSchema.safeParse({ timezone: 'Not/AZone' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['timezone']);
    }
  });

  it('requires the field — an explicit preference write with no zone has no meaning', () => {
    expect(UserTimezoneSchema.safeParse({}).success).toBe(false);
    expect(UserTimezoneSchema.safeParse({ timezone: null }).success).toBe(false);
  });
});

describe('RegisterSchema.timezone', () => {
  // Scripted registrations and the existing e2e helpers post without it (R2.3).
  it('is optional — registering without it still parses', () => {
    const result = RegisterSchema.safeParse(baseRegister);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timezone).toBeUndefined();
  });

  it('accepts a body with a browser-detected zone', () => {
    const result = RegisterSchema.safeParse({ ...baseRegister, timezone: 'Asia/Tokyo' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timezone).toBe('Asia/Tokyo');
  });

  it.each(['UTC', 'Etc/GMT+5'])('accepts %s at registration', (tz) => {
    expect(RegisterSchema.safeParse({ ...baseRegister, timezone: tz }).success).toBe(true);
  });

  it.each(['America/New_York-u-ca-japanese', 'Not/AZone', '', 'A'.repeat(65)])(
    'rejects %j with a field error',
    (tz) => {
      const result = RegisterSchema.safeParse({ ...baseRegister, timezone: tz });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === 'timezone')).toBe(true);
      }
    },
  );

  // The email/password chain is frozen — adding the field must not have moved
  // which raw inputs the endpoint accepts. `.email()` runs BEFORE `.trim()`
  // here (unlike EmailField), so a padded address is rejected rather than
  // trimmed into validity; that asymmetry is the thing the auth.ts comment
  // protects, so assert it alongside the parts that do normalize.
  it('leaves the frozen email/password chain unmoved', () => {
    const result = RegisterSchema.safeParse({
      email: 'Trader@Example.COM',
      password: 'correct-horse',
      timezone: 'Europe/London',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('trader@example.com');

    expect(
      RegisterSchema.safeParse({ ...baseRegister, email: '  trader@example.com  ' }).success,
    ).toBe(false);
    expect(RegisterSchema.safeParse({ ...baseRegister, password: 'short' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  AccountSchema,
  CreateAccountSchema,
  SetDefaultAccountSchema,
  UpdateAccountSchema,
} from './account';

const baseCreate = { name: 'Main', currency: 'USD' };

describe('CreateAccountSchema.defaultRiskPercent', () => {
  it('is optional — omitting it means no rule is set', () => {
    const result = CreateAccountSchema.safeParse(baseCreate);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.defaultRiskPercent).toBeUndefined();
  });

  it.each(['1', '3', '2.5', '0.01', '100', '99.99'])('accepts %s', (v) => {
    expect(CreateAccountSchema.safeParse({ ...baseCreate, defaultRiskPercent: v }).success).toBe(
      true,
    );
  });

  // Zero is the absence of a rule, not a rule to risk nothing — absence is
  // already expressed by omitting the field.
  it.each(['0', '0.00', '-1', '-0.5'])('rejects %s (not above zero)', (v) => {
    expect(CreateAccountSchema.safeParse({ ...baseCreate, defaultRiskPercent: v }).success).toBe(
      false,
    );
  });

  it.each(['100.01', '101', '999.99'])('rejects %s (above 100)', (v) => {
    expect(CreateAccountSchema.safeParse({ ...baseCreate, defaultRiskPercent: v }).success).toBe(
      false,
    );
  });

  // The numeric(5,2) column would silently round a third decimal, so the
  // schema rejects it rather than storing something the user did not type.
  it.each(['3.141', '2.005', '1.00000'])('rejects %s (more than 2 decimal places)', (v) => {
    expect(CreateAccountSchema.safeParse({ ...baseCreate, defaultRiskPercent: v }).success).toBe(
      false,
    );
  });

  // Number('  3  ') passes a bounds check but new Decimal('  3  ') throws
  // server-side, so whitespace must fail at the schema, not in the service.
  it.each([' 3', '3 ', ' 3 ', '', '  '])('rejects %j (whitespace or empty)', (v) => {
    expect(CreateAccountSchema.safeParse({ ...baseCreate, defaultRiskPercent: v }).success).toBe(
      false,
    );
  });

  it.each(['abc', 'NaN', 'Infinity', '3%'])('rejects %s (not a number)', (v) => {
    expect(CreateAccountSchema.safeParse({ ...baseCreate, defaultRiskPercent: v }).success).toBe(
      false,
    );
  });

  it('rejects a numeric literal — the field is a decimal string', () => {
    expect(CreateAccountSchema.safeParse({ ...baseCreate, defaultRiskPercent: 3 }).success).toBe(
      false,
    );
  });
});

describe('UpdateAccountSchema.defaultRiskPercent', () => {
  // Editable after creation, unlike startingBalance, because it rewrites no
  // history — it only seeds a form field.
  it('accepts a new value', () => {
    expect(UpdateAccountSchema.safeParse({ defaultRiskPercent: '2.5' }).success).toBe(true);
  });

  it('accepts null to clear the rule back to unset', () => {
    const result = UpdateAccountSchema.safeParse({ defaultRiskPercent: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.defaultRiskPercent).toBeNull();
  });

  it('omitting it leaves the stored value untouched (undefined, not null)', () => {
    const result = UpdateAccountSchema.safeParse({ name: 'Renamed' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.defaultRiskPercent).toBeUndefined();
  });

  it('applies the same bounds as create', () => {
    expect(UpdateAccountSchema.safeParse({ defaultRiskPercent: '0' }).success).toBe(false);
    expect(UpdateAccountSchema.safeParse({ defaultRiskPercent: '101' }).success).toBe(false);
    expect(UpdateAccountSchema.safeParse({ defaultRiskPercent: '3.141' }).success).toBe(false);
  });

  // startingBalance stays creation-only: the derived balance is
  // startingBalance + SUM(ledger), so editing it would move every historical
  // figure. Guard the distinction so it cannot be blurred later.
  it('still strips startingBalance (creation-only)', () => {
    const result = UpdateAccountSchema.safeParse({ startingBalance: '1000' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('startingBalance');
    }
  });
});

describe('AccountSchema.defaultRiskPercent', () => {
  const baseAccount = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    name: 'Main',
    currency: 'USD',
    timezone: 'America/New_York',
    brokerageId: null,
    brokerageName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('parses when the field is absent (existing fixtures keep working)', () => {
    expect(AccountSchema.safeParse(baseAccount).success).toBe(true);
  });

  it('parses null for an account with no rule set', () => {
    expect(AccountSchema.safeParse({ ...baseAccount, defaultRiskPercent: null }).success).toBe(
      true,
    );
  });

  it('parses a stored value', () => {
    const result = AccountSchema.safeParse({ ...baseAccount, defaultRiskPercent: '3.00' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.defaultRiskPercent).toBe('3.00');
  });

  describe('isDefault', () => {
    it('parses when the field is absent (existing fixtures keep working)', () => {
      const result = AccountSchema.safeParse(baseAccount);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.isDefault).toBeUndefined();
    });

    it('parses a stored value', () => {
      const result = AccountSchema.safeParse({ ...baseAccount, isDefault: true });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.isDefault).toBe(true);
    });

    // Server-set only, like isDemo: no request body may claim it.
    it('is absent from CreateAccountSchema and UpdateAccountSchema', () => {
      const created = CreateAccountSchema.safeParse({ ...baseCreate, isDefault: true });
      expect(created.success).toBe(true);
      if (created.success) expect(created.data).not.toHaveProperty('isDefault');
      const updated = UpdateAccountSchema.safeParse({ isDefault: true });
      expect(updated.success).toBe(true);
      if (updated.success) expect(updated.data).not.toHaveProperty('isDefault');
    });
  });
});

describe('SetDefaultAccountSchema', () => {
  it('accepts a uuid accountId', () => {
    expect(
      SetDefaultAccountSchema.safeParse({ accountId: '11111111-1111-4111-8111-111111111111' })
        .success,
    ).toBe(true);
  });

  it.each([[{}], [{ accountId: 'not-a-uuid' }], [{ accountId: 42 }]])('rejects %j', (body) => {
    expect(SetDefaultAccountSchema.safeParse(body).success).toBe(false);
  });
});

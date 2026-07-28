import { describe, expect, it } from 'vitest';

import {
  AdminStatsSchema,
  AdminUsageQuerySchema,
  AdminUsageSchema,
  AdminUserDetailSchema,
  AdminUserListItemSchema,
  AdminUserListResponseSchema,
  ToggleAdminRequestSchema,
} from './admin';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function validStats() {
  return {
    totalUsers: 12,
    activeUsers: 3,
    activeUsersWindowMinutes: 30,
    positions: { total: 40, draft: 5, open: 10, closed: 25 },
    revenue: { allTime: '125000000', currentMonth: '0', basis: 'purchased-credit-volume' },
  };
}

function validListItem() {
  return {
    id: UUID_A,
    email: 'user@example.com',
    isAdmin: false,
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: null,
  };
}

function validDetail() {
  return {
    ...validListItem(),
    positionCount: 7,
    advisorTurns: 4,
    usage: { inputTokens: '1000', outputTokens: '2000', billedCredits: '36000' },
    walletBalance: '5000000',
  };
}

function validUsage() {
  return {
    period: { from: '2026-05-01T00:00:00.000Z', to: '2026-05-31T00:00:00.000Z' },
    totals: {
      inputTokens: '123456',
      outputTokens: '654321',
      billedCredits: '99000',
      providerCost: '82500',
      providerCostCoverage: { records: 10, recordsWithRawCost: 8 },
    },
    series: [{ day: '2026-05-01', billedCredits: '1000', inputTokens: '10', outputTokens: '20' }],
    topUsers: [
      {
        userId: UUID_B,
        email: 'top@example.com',
        billedCredits: '5000',
        inputTokens: '100',
        outputTokens: '200',
        turns: 3,
      },
    ],
    revenue: { credited: '10000000', reversed: '-1000000', net: '9000000' },
  };
}

// ---------------------------------------------------------------------------
// AdminStatsSchema
// ---------------------------------------------------------------------------

describe('AdminStatsSchema', () => {
  it('parses a valid stats payload', () => {
    expect(AdminStatsSchema.safeParse(validStats()).success).toBe(true);
  });

  it('parses an empty-instance zero payload', () => {
    const stats = {
      totalUsers: 0,
      activeUsers: 0,
      activeUsersWindowMinutes: 30,
      positions: { total: 0, draft: 0, open: 0, closed: 0 },
      revenue: { allTime: '0', currentMonth: '0', basis: 'purchased-credit-volume' },
    };
    expect(AdminStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('rejects a non-pinned activeUsersWindowMinutes', () => {
    const stats = { ...validStats(), activeUsersWindowMinutes: 60 };
    expect(AdminStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects a non-pinned revenue basis', () => {
    const stats = validStats();
    stats.revenue.basis = 'gross-margin';
    expect(AdminStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects revenue as a number instead of an integer string', () => {
    const stats = validStats();
    (stats.revenue as Record<string, unknown>).allTime = 125000000;
    expect(AdminStatsSchema.safeParse(stats).success).toBe(false);
  });

  it('rejects a float string in revenue.currentMonth', () => {
    const stats = validStats();
    stats.revenue.currentMonth = '12.5';
    expect(AdminStatsSchema.safeParse(stats).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminUserListItemSchema / AdminUserListResponseSchema
// ---------------------------------------------------------------------------

describe('AdminUserListItemSchema', () => {
  it('parses a never-active user (lastActiveAt null)', () => {
    expect(AdminUserListItemSchema.safeParse(validListItem()).success).toBe(true);
  });

  it('parses an active user with a timestamp', () => {
    const item = { ...validListItem(), lastActiveAt: '2026-06-10T12:00:00.000Z' };
    expect(AdminUserListItemSchema.safeParse(item).success).toBe(true);
  });

  it('rejects a non-uuid id', () => {
    const item = { ...validListItem(), id: 'not-a-uuid' };
    expect(AdminUserListItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a missing isAdmin flag', () => {
    const item: Partial<ReturnType<typeof validListItem>> = validListItem();
    delete item.isAdmin;
    expect(AdminUserListItemSchema.safeParse(item).success).toBe(false);
  });

  it('parses both emailVerified states and rejects a missing/non-boolean flag (REQ-5.7)', () => {
    expect(AdminUserListItemSchema.safeParse(validListItem()).success).toBe(true);
    const unverified = { ...validListItem(), emailVerified: false };
    expect(AdminUserListItemSchema.safeParse(unverified).success).toBe(true);
    const item: Partial<ReturnType<typeof validListItem>> = validListItem();
    delete item.emailVerified;
    expect(AdminUserListItemSchema.safeParse(item).success).toBe(false);
    expect(
      AdminUserListItemSchema.safeParse({ ...validListItem(), emailVerified: 'true' }).success,
    ).toBe(false);
  });
});

describe('AdminUserListResponseSchema', () => {
  it('parses items with a string cursor', () => {
    const res = { items: [validListItem()], nextCursor: 'opaque-cursor' };
    expect(AdminUserListResponseSchema.safeParse(res).success).toBe(true);
  });

  it('parses an empty last page with a null cursor', () => {
    expect(AdminUserListResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(
      true,
    );
  });

  it('rejects a missing nextCursor', () => {
    expect(AdminUserListResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminUserDetailSchema
// ---------------------------------------------------------------------------

describe('AdminUserDetailSchema', () => {
  it('parses a valid detail payload', () => {
    expect(AdminUserDetailSchema.safeParse(validDetail()).success).toBe(true);
  });

  it('rejects float strings in usage token sums', () => {
    const detail = validDetail();
    detail.usage.inputTokens = '10.5';
    expect(AdminUserDetailSchema.safeParse(detail).success).toBe(false);
  });

  it('rejects a numeric walletBalance', () => {
    const detail = { ...validDetail(), walletBalance: 5000000 };
    expect(AdminUserDetailSchema.safeParse(detail).success).toBe(false);
  });

  it('rejects a float positionCount', () => {
    const detail = { ...validDetail(), positionCount: 1.5 };
    expect(AdminUserDetailSchema.safeParse(detail).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToggleAdminRequestSchema
// ---------------------------------------------------------------------------

describe('ToggleAdminRequestSchema', () => {
  it('parses both boolean values', () => {
    expect(ToggleAdminRequestSchema.safeParse({ isAdmin: true }).success).toBe(true);
    expect(ToggleAdminRequestSchema.safeParse({ isAdmin: false }).success).toBe(true);
  });

  it('rejects non-boolean isAdmin', () => {
    expect(ToggleAdminRequestSchema.safeParse({ isAdmin: 'true' }).success).toBe(false);
    expect(ToggleAdminRequestSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminUsageQuerySchema — cross-field rules
// ---------------------------------------------------------------------------

describe('AdminUsageQuerySchema', () => {
  it('parses an ordinary range', () => {
    const q = { from: '2026-05-01T00:00:00Z', to: '2026-05-31T00:00:00Z' };
    expect(AdminUsageQuerySchema.safeParse(q).success).toBe(true);
  });

  it('parses with both fields omitted (API defaults the trailing 30 days)', () => {
    expect(AdminUsageQuerySchema.safeParse({}).success).toBe(true);
  });

  it('rejects from > to (negative range)', () => {
    const q = { from: '2026-05-31T00:00:00Z', to: '2026-05-01T00:00:00Z' };
    const result = AdminUsageQuerySchema.safeParse(q);
    expect(result.success).toBe(false);
  });

  it('rejects a range longer than 366 days', () => {
    const q = { from: '2025-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };
    expect(AdminUsageQuerySchema.safeParse(q).success).toBe(false);
  });

  it('accepts a range of exactly 366 days', () => {
    const q = { from: '2025-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };
    expect(AdminUsageQuerySchema.safeParse(q).success).toBe(true);
  });

  it('accepts from == to', () => {
    const q = { from: '2026-05-01T00:00:00Z', to: '2026-05-01T00:00:00Z' };
    expect(AdminUsageQuerySchema.safeParse(q).success).toBe(true);
  });

  it('accepts a future range', () => {
    const q = { from: '2030-01-01T00:00:00Z', to: '2030-01-31T00:00:00Z' };
    expect(AdminUsageQuerySchema.safeParse(q).success).toBe(true);
  });

  it('rejects a negative range even though its length is under 366 days', () => {
    // A naive |to - from| <= 366d length check alone would pass this.
    const q = { from: '2026-05-02T00:00:00Z', to: '2026-05-01T00:00:00Z' };
    expect(AdminUsageQuerySchema.safeParse(q).success).toBe(false);
  });

  it('rejects non-ISO datetimes', () => {
    expect(AdminUsageQuerySchema.safeParse({ from: '2026-05-01' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminUsageSchema
// ---------------------------------------------------------------------------

describe('AdminUsageSchema', () => {
  it('parses a valid usage payload', () => {
    expect(AdminUsageSchema.safeParse(validUsage()).success).toBe(true);
  });

  it('parses a zero/empty payload with providerCost null', () => {
    const usage = {
      period: { from: '2026-05-01T00:00:00.000Z', to: '2026-05-31T00:00:00.000Z' },
      totals: {
        inputTokens: '0',
        outputTokens: '0',
        billedCredits: '0',
        providerCost: null,
        providerCostCoverage: { records: 0, recordsWithRawCost: 0 },
      },
      series: [],
      topUsers: [],
      revenue: { credited: '0', reversed: '0', net: '0' },
    };
    expect(AdminUsageSchema.safeParse(usage).success).toBe(true);
  });

  it('rejects more than 50 topUsers', () => {
    const usage = validUsage();
    usage.topUsers = Array.from({ length: 51 }, () => validUsage().topUsers[0]!);
    expect(AdminUsageSchema.safeParse(usage).success).toBe(false);
  });

  it('rejects a non-UTC-day series bucket', () => {
    const usage = validUsage();
    usage.series[0]!.day = '2026-05-01T00:00:00Z';
    expect(AdminUsageSchema.safeParse(usage).success).toBe(false);
  });

  it('rejects float strings in totals', () => {
    const usage = validUsage();
    usage.totals.billedCredits = '99000.5';
    expect(AdminUsageSchema.safeParse(usage).success).toBe(false);
  });

  it('rejects a numeric providerCost', () => {
    const usage = validUsage();
    (usage.totals as Record<string, unknown>).providerCost = 82500;
    expect(AdminUsageSchema.safeParse(usage).success).toBe(false);
  });

  it('accepts a negative reversed revenue and rejects a float net', () => {
    const usage = validUsage();
    usage.revenue.reversed = '-2500000';
    expect(AdminUsageSchema.safeParse(usage).success).toBe(true);
    usage.revenue.net = '1.5';
    expect(AdminUsageSchema.safeParse(usage).success).toBe(false);
  });
});

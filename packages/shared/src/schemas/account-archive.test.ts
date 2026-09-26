import { describe, expect, it } from 'vitest';

import { ArchiveManifestSchema as BarrelManifestSchema } from '../index';

import {
  ACCOUNT_DATA_ERROR_CODES,
  ARCHIVE_CAPS,
  ARCHIVE_DATE_RE,
  ARCHIVE_ENTRY_ORDER,
  ARCHIVE_IMAGE_ENTRY_RE,
  ARCHIVE_TIMESTAMP_RE,
  ARCHIVE_VERSION,
  ArchiveAccountSchema,
  ArchiveBrokerageSchema,
  ArchiveBuiltinPersonaRefSchema,
  ArchiveContentPartSchema,
  ArchiveConversationSchema,
  ArchiveCountsSchema,
  ArchiveDashboardLayoutSchema,
  ArchiveExchangeRateSchema,
  ArchiveExpenseSchema,
  ArchiveFillSchema,
  ArchiveImagePartSchema,
  ArchiveLedgerEntrySchema,
  ArchiveManifestSchema,
  ArchiveMessageSchema,
  ArchivePersonaSchema,
  ArchivePositionImageSchema,
  ArchivePositionSchema,
  ArchivePositionTagSchema,
  ArchivePreferencesSchema,
  ArchiveSummarySchema,
  ArchiveSystemBrokerageRefSchema,
  ArchiveTagSchema,
  archiveDecimalString,
} from './account-archive';

const TS = '2026-09-26T14:10:06.048123Z';
const DATE = '2026-09-26';
const U = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`.slice(0, 36);

const counts = {
  brokerages: 0,
  systemBrokerages: 0,
  accounts: 0,
  tags: 0,
  positions: 0,
  fills: 0,
  positionTags: 0,
  positionImages: 0,
  ledgerEntries: 0,
  exchangeRates: 0,
  expenses: 0,
  personas: 0,
  builtinPersonas: 0,
  conversations: 0,
  messages: 0,
  summaries: 0,
  images: 0,
};

const fee = {
  stockPerShareCommission: '0',
  stockMinPerFill: '0',
  stockMaxPerFill: '0',
  optionsPerContractCommission: '0',
  optionsPerContractExchangeFee: '0',
  optionsMinPerFill: '0',
  optionsMaxPerFill: '0',
};

// One valid row per object-shaped entry schema.
const rows = {
  manifest: {
    schema: ArchiveManifestSchema,
    value: {
      format: 'tradr-account-archive',
      archiveVersion: 1,
      sourceAppVersion: '0.5.0',
      exportedAt: TS,
      counts,
      degradations: [],
    },
  },
  counts: { schema: ArchiveCountsSchema, value: counts },
  brokerage: {
    schema: ArchiveBrokerageSchema,
    value: {
      id: U(1),
      name: 'My Broker',
      notes: null,
      feeSchedule: { ...fee, createdAt: TS, updatedAt: TS },
      createdAt: TS,
      updatedAt: TS,
    },
  },
  systemRef: {
    schema: ArchiveSystemBrokerageRefSchema,
    value: { name: 'IBKR', feeSchedule: { ...fee } },
  },
  account: {
    schema: ArchiveAccountSchema,
    value: {
      id: U(2),
      name: 'Main',
      currency: 'USD',
      timezone: 'America/New_York',
      brokerage: null,
      startingBalance: '1000.0000',
      defaultRiskPercent: null,
      isDemo: false,
      isDefault: true,
      createdAt: TS,
      updatedAt: TS,
    },
  },
  tag: {
    schema: ArchiveTagSchema,
    value: {
      id: U(3),
      name: 'breakout',
      category: 'setup',
      color: null,
      createdAt: TS,
      updatedAt: TS,
    },
  },
  position: {
    schema: ArchivePositionSchema,
    value: {
      id: U(4),
      accountId: U(2),
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      notes: null,
      targetPrice: null,
      stopLoss: null,
      openedAt: TS,
      closedAt: null,
      lastFlatAt: null,
      lastFlatNetPnl: null,
      createdAt: TS,
      updatedAt: TS,
    },
  },
  fill: {
    schema: ArchiveFillSchema,
    value: {
      id: U(5),
      positionId: U(4),
      type: 'entry',
      price: '100.00000000',
      quantity: '10.00000000',
      fees: '0',
      notes: null,
      filledAt: TS,
      createdAt: TS,
    },
  },
  positionTag: { schema: ArchivePositionTagSchema, value: { positionId: U(4), tagId: U(3) } },
  positionImage: {
    schema: ArchivePositionImageSchema,
    value: {
      id: U(6),
      positionId: U(4),
      part: { type: 'image', format: 'png', entry: 'images/positions/000001.png' },
      createdAt: TS,
    },
  },
  ledger: {
    schema: ArchiveLedgerEntrySchema,
    value: {
      id: U(7),
      accountId: U(2),
      positionId: null,
      entryType: 'position_pnl',
      direction: 'credit',
      amount: '50.0000',
      currency: 'USD',
      symbol: null,
      occurredAt: TS,
      createdAt: TS,
      groupId: U(8),
      reversesGroupId: null,
    },
  },
  rate: {
    schema: ArchiveExchangeRateSchema,
    value: {
      id: U(9),
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '1.100000000000',
      effectiveDate: DATE,
      createdAt: TS,
    },
  },
  expense: {
    schema: ArchiveExpenseSchema,
    value: {
      id: U(1),
      category: 'software',
      description: 'IDE',
      amount: '9.9900',
      currency: 'USD',
      occurredAt: DATE,
      notes: null,
      createdAt: TS,
      updatedAt: TS,
    },
  },
  persona: {
    schema: ArchivePersonaSchema,
    value: {
      id: U(2),
      name: 'My Coach',
      description: null,
      systemPrompt: 'Be helpful',
      isDefault: false,
      createdAt: TS,
      updatedAt: TS,
    },
  },
  builtinRef: { schema: ArchiveBuiltinPersonaRefSchema, value: { id: 'default-trading-advisor' } },
  conversation: {
    schema: ArchiveConversationSchema,
    value: {
      id: U(3),
      title: 'Chat',
      persona: null,
      providerId: 'claude',
      model: 'claude-sonnet',
      createdAt: TS,
      updatedAt: TS,
    },
  },
  message: {
    schema: ArchiveMessageSchema,
    value: {
      id: U(4),
      conversationId: U(3),
      role: 'user',
      contentParts: [{ type: 'text', text: 'hi' }],
      promptTokens: null,
      completionTokens: null,
      clientMessageId: null,
      createdAt: TS,
    },
  },
  summary: {
    schema: ArchiveSummarySchema,
    value: {
      id: U(5),
      conversationId: U(3),
      prose: 'A summary',
      tradeDataFigures: null,
      coveredThroughMessageId: null,
      coveredThroughCreatedAt: TS,
      createdAt: TS,
      updatedAt: TS,
    },
  },
  preferences: {
    schema: ArchivePreferencesSchema,
    value: {
      displayCurrency: 'USD',
      timezone: 'America/New_York',
      taxJurisdiction: null,
      theme: 'system',
      buyingPowerBasis: 'cash',
      advisorDefaultPersona: null,
      advisorTradeDataConsent: false,
      writableAccountId: null,
      onboarding: {},
    },
  },
} as const;

describe('account-archive contract constants', () => {
  it('freezes the version, entry order and caps', () => {
    expect(ARCHIVE_VERSION).toBe(1);
    expect(ARCHIVE_ENTRY_ORDER[0]).toBe('manifest.json');
    expect(ARCHIVE_ENTRY_ORDER).toContain('dashboard-layout.json');
    expect(Object.keys(ARCHIVE_CAPS)).toHaveLength(10);
    expect(ARCHIVE_CAPS.maxUploadBytes).toBe(536_870_912);
    expect(ARCHIVE_CAPS.maxDecompressedBytes).toBe(2_147_483_648);
  });

  it('exposes exactly the eight new error codes', () => {
    expect([...ACCOUNT_DATA_ERROR_CODES]).toEqual([
      'ARCHIVE_VERSION_UNSUPPORTED',
      'ARCHIVE_INVALID',
      'ARCHIVE_EMPTY',
      'ARCHIVE_DIGEST_MISMATCH',
      'IMPORT_TARGET_NOT_EMPTY',
      'ARCHIVE_TOO_LARGE',
      'IMPORT_FAILED',
      'IMPORT_BUSY',
    ]);
    expect(ACCOUNT_DATA_ERROR_CODES).not.toContain('OBJECT_UNREACHABLE');
    expect(ACCOUNT_DATA_ERROR_CODES).not.toContain('RATE_LIMITED');
  });

  it('re-exports the contract from the package barrel', () => {
    expect(BarrelManifestSchema).toBe(ArchiveManifestSchema);
  });
});

describe('every entry schema parses its valid row', () => {
  for (const [name, { schema, value }] of Object.entries(rows)) {
    it(`accepts a valid ${name}`, () => {
      expect(schema.safeParse(value).success).toBe(true);
    });
  }
});

describe('strictness: unknown keys and userId are rejected', () => {
  for (const [name, { schema, value }] of Object.entries(rows)) {
    it(`${name} rejects an unknown key`, () => {
      expect(schema.safeParse({ ...value, somethingNew: 1 }).success).toBe(false);
    });
    it(`${name} carries no userId`, () => {
      expect('userId' in value).toBe(false);
      expect(schema.safeParse({ ...value, userId: U(1) }).success).toBe(false);
    });
  }
});

describe('timestamp regex bounds (T)', () => {
  it('accepts a six-digit microsecond UTC instant', () => {
    expect(ARCHIVE_TIMESTAMP_RE.test('2026-09-26T14:10:06.048123Z')).toBe(true);
  });
  it('rejects five, seven, missing-Z and missing-fraction forms', () => {
    expect(ARCHIVE_TIMESTAMP_RE.test('2026-09-26T14:10:06.04812Z')).toBe(false);
    expect(ARCHIVE_TIMESTAMP_RE.test('2026-09-26T14:10:06.0481234Z')).toBe(false);
    expect(ARCHIVE_TIMESTAMP_RE.test('2026-09-26T14:10:06.048123')).toBe(false);
    expect(ARCHIVE_TIMESTAMP_RE.test('2026-09-26T14:10:06Z')).toBe(false);
  });
  it('is wired into a row schema', () => {
    expect(
      ArchiveMessageSchema.safeParse({ ...rows.message.value, createdAt: '2026-09-26 14:10:06Z' })
        .success,
    ).toBe(false);
  });
  it('date regex accepts YYYY-MM-DD and rejects unpadded', () => {
    expect(ARCHIVE_DATE_RE.test(DATE)).toBe(true);
    expect(ARCHIVE_DATE_RE.test('2026-9-6')).toBe(false);
  });
});

describe('decimal regex bounds (D(p,s))', () => {
  const signed = archiveDecimalString(18, 4, { signed: true });
  const unsigned = archiveDecimalString(18, 4, { signed: false });
  const rate = archiveDecimalString(24, 12, { signed: false });

  it('accepts values at the precision/scale bound', () => {
    expect(signed.safeParse('99999999999999.9999').success).toBe(true); // 14 int, 4 frac
    expect(signed.safeParse('-99999999999999.9999').success).toBe(true);
    expect(signed.safeParse('0').success).toBe(true);
    expect(rate.safeParse('999999999999.999999999999').success).toBe(true); // 12 int, 12 frac
  });

  it('rejects one digit past integer or fractional scale', () => {
    expect(signed.safeParse('999999999999999.9999').success).toBe(false); // 15 int
    expect(signed.safeParse('1.99999').success).toBe(false); // 5 frac
    expect(rate.safeParse('9999999999999.0').success).toBe(false); // 13 int
    expect(rate.safeParse('1.9999999999999').success).toBe(false); // 13 frac
  });

  it('honours the sign rule from the DB CHECK', () => {
    expect(unsigned.safeParse('-1.0000').success).toBe(false);
    expect(unsigned.safeParse('1.0000').success).toBe(true);
    // ledger amount is unsigned (amount >= 0); a negative is rejected.
    expect(
      ArchiveLedgerEntrySchema.safeParse({ ...rows.ledger.value, amount: '-1.0000' }).success,
    ).toBe(false);
    // last-flat P&L is signed.
    expect(
      ArchivePositionSchema.safeParse({ ...rows.position.value, lastFlatNetPnl: '-50.0000' })
        .success,
    ).toBe(true);
  });

  it('rejects a distinct-currency violation on rates', () => {
    expect(
      ArchiveExchangeRateSchema.safeParse({ ...rows.rate.value, quoteCurrency: 'USD' }).success,
    ).toBe(false);
  });
});

describe('content and image parts', () => {
  it('accepts text, tool_call, tool_result and the two image arms', () => {
    for (const part of [
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 1 } },
      { type: 'tool_result', toolCallId: 'c1', status: 'ok', content: [1, 2] },
      { type: 'image', format: 'png', entry: 'images/advisor/000001.png' },
      { type: 'image', format: 'webp', storage: { kind: 'unrecoverable' } },
    ]) {
      expect(ArchiveContentPartSchema.safeParse(part).success).toBe(true);
    }
  });

  it('rejects an object pointer and an inline dataBase64 image', () => {
    const pointer = { type: 'image', format: 'png', storage: { kind: 'object', key: 'k' } };
    const inline = { type: 'image', format: 'png', dataBase64: 'AAAA' };
    expect(ArchiveContentPartSchema.safeParse(pointer).success).toBe(false);
    expect(ArchiveContentPartSchema.safeParse(inline).success).toBe(false);
    expect(ArchiveImagePartSchema.safeParse(pointer).success).toBe(false);
    expect(ArchiveImagePartSchema.safeParse(inline).success).toBe(false);
  });
});

describe('image entry pattern (ARCHIVE_IMAGE_ENTRY_RE)', () => {
  it('accepts the two homes, six digits and each format', () => {
    expect(ARCHIVE_IMAGE_ENTRY_RE.test('images/advisor/000001.png')).toBe(true);
    expect(ARCHIVE_IMAGE_ENTRY_RE.test('images/positions/123456.webp')).toBe(true);
    expect(ARCHIVE_IMAGE_ENTRY_RE.test('images/advisor/000042.jpeg')).toBe(true);
  });

  it('rejects traversal, absolute and malformed names', () => {
    for (const name of [
      '../images/advisor/000001.png',
      'images/advisor/../000001.png',
      '/images/advisor/000001.png',
      'images/other/000001.png',
      'images/advisor/00001.png', // five digits
      'images/advisor/0000001.png', // seven digits
      'images/advisor/000001.gif',
      'images/advisor/000001.png\n', // trailing newline
    ]) {
      expect(ARCHIVE_IMAGE_ENTRY_RE.test(name)).toBe(false);
    }
  });
});

describe('dashboard layout entry', () => {
  it('accepts null and the widgets-object form, and rejects extra keys', () => {
    expect(ArchiveDashboardLayoutSchema.safeParse(null).success).toBe(true);
    expect(
      ArchiveDashboardLayoutSchema.safeParse({ widgets: [], createdAt: TS, updatedAt: TS }).success,
    ).toBe(true);
    expect(
      ArchiveDashboardLayoutSchema.safeParse({
        widgets: [],
        createdAt: TS,
        updatedAt: TS,
        theme: 'dark',
      }).success,
    ).toBe(false);
  });
});

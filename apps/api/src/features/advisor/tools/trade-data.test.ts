import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the data-access layer so handler tests need no DB: each summary query /
// the performance service becomes a spy whose calls we assert (userId scoping).
vi.mock('@/features/positions/positions.query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/positions/positions.query')>();
  return {
    ...actual,
    selectOpenPositionsSummary: vi.fn(async () => []),
    selectRecentClosedSummary: vi.fn(async () => []),
  };
});
vi.mock('@/features/accounts/accounts.query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/accounts/accounts.query')>();
  return { ...actual, selectAccountSummaries: vi.fn(async () => []) };
});
vi.mock('@/features/performance/performance.service', () => ({
  getPerformance: vi.fn(async () => ({
    resolvedTimezone: 'UTC',
    defaultCurrency: 'USD',
    hasAnyClosedPositions: false,
    currencies: [],
  })),
}));

import { selectAccountSummaries } from '@/features/accounts/accounts.query';
import { getPerformance } from '@/features/performance/performance.service';
import {
  selectOpenPositionsSummary,
  selectRecentClosedSummary,
  RECENT_CLOSED_SUMMARY_CAP,
} from '@/features/positions/positions.query';

import {
  createTurnState,
  dispatchTool,
  TRADE_DATA_EGRESS_CAP,
  type DispatchDeps,
  type DispatchSnapshot,
  type ToolCall,
} from './dispatch';
import { bucketOf } from './error-codes';
import { toolRegistry } from './registry';
import {
  accountSummaryTool,
  openPositionsTool,
  pnlSummaryTool,
  recentClosedTool,
  tradeDataTools,
} from './trade-data';
import type { ToolContext } from './types';

beforeEach(() => {
  vi.clearAllMocks();
});

function ctx(userId = 'owner-1'): ToolContext {
  return { userId, conversationId: 'c1', signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// Definitions + registry
// ---------------------------------------------------------------------------

describe('trade-data tool definitions', () => {
  it('declares all four as trade-data, consent-gated, with EXACT egress bounds', () => {
    for (const tool of tradeDataTools) {
      expect(tool.category).toBe('trade-data');
      expect(tool.requires).toBe('trade-data-consent');
    }
    expect(openPositionsTool.maxEstTokens).toBe(3000);
    expect(recentClosedTool.maxEstTokens).toBe(1500);
    // Raised from 1500 when the cash/position split widened each account row
    // from five fields to seven (ledger-balances Req 10).
    expect(accountSummaryTool.maxEstTokens).toBe(2000);
    expect(pnlSummaryTool.maxEstTokens).toBe(800);
  });

  it('registers all four in the registry', () => {
    expect(toolRegistry.trade_data_open_positions).toBe(openPositionsTool);
    expect(toolRegistry.trade_data_recent_closed).toBe(recentClosedTool);
    expect(toolRegistry.trade_data_account_summary).toBe(accountSummaryTool);
    expect(toolRegistry.trade_data_pnl_summary).toBe(pnlSummaryTool);
  });
});

// ---------------------------------------------------------------------------
// Handlers — userId scoping (REQ-9.4) + no UW client
// ---------------------------------------------------------------------------

describe('trade-data handlers scope every query to ctx.userId (REQ-9.4)', () => {
  it('open positions queries the context userId', async () => {
    const result = await openPositionsTool.handler({}, ctx('owner-1'));
    expect(selectOpenPositionsSummary).toHaveBeenCalledWith(expect.anything(), 'owner-1');
    expect(result.status).toBe('ok');
  });

  it('recent closed forwards userId and defaults the limit to the cap', async () => {
    await recentClosedTool.handler({}, ctx('owner-2'));
    expect(selectRecentClosedSummary).toHaveBeenCalledWith(
      expect.anything(),
      'owner-2',
      RECENT_CLOSED_SUMMARY_CAP,
    );
  });

  it('recent closed honors a provided limit', async () => {
    await recentClosedTool.handler({ limit: 5 }, ctx('owner-2'));
    expect(selectRecentClosedSummary).toHaveBeenCalledWith(expect.anything(), 'owner-2', 5);
  });

  it('account summary queries the context userId', async () => {
    await accountSummaryTool.handler({}, ctx('owner-3'));
    expect(selectAccountSummaries).toHaveBeenCalledWith(expect.anything(), 'owner-3');
  });

  it('pnl summary forwards userId + flat inputs to getPerformance and projects compactly', async () => {
    const c = ctx('owner-4');
    const result = await pnlSummaryTool.handler(
      { granularity: 'month', start: '2026-01-01', end: '2026-03-01' },
      c,
    );
    expect(getPerformance).toHaveBeenCalledWith(
      expect.anything(),
      'owner-4',
      {
        granularity: 'month',
        start: '2026-01-01',
        end: '2026-03-01',
        tz: 'UTC',
        currency: undefined,
      },
      c.signal,
      expect.any(Number),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // Only per-currency stats are projected, never the full series.
      expect(result.content).not.toHaveProperty('currencies.0.series');
    }
  });

  it('rejects an over-cap window with TOOL_INPUT_INVALID before calling getPerformance (F2)', async () => {
    // ~1826 daily buckets exceeds the route's BUCKET_COUNT_CAP (1095). The tool
    // must apply the same bound the HTTP route enforces so the unbounded
    // getPerformance bucket loop is never reached.
    const result = await pnlSummaryTool.handler(
      { granularity: 'day', start: '2010-01-01', end: '2015-01-01' },
      ctx('owner-5'),
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('TOOL_INPUT_INVALID');
    }
    expect(getPerformance).not.toHaveBeenCalled();
  });
});

describe('trade-data input schemas are flat scalar objects', () => {
  it('recent closed bounds the optional limit to 1-20', () => {
    const s = recentClosedTool.inputSchema;
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ limit: 20 }).success).toBe(true);
    expect(s.safeParse({ limit: 21 }).success).toBe(false);
    expect(s.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('pnl summary requires granularity/start/end', () => {
    const s = pnlSummaryTool.inputSchema;
    expect(s.safeParse({ granularity: 'day', start: 'a', end: 'b' }).success).toBe(true);
    expect(s.safeParse({ granularity: 'decade', start: 'a', end: 'b' }).success).toBe(false);
    expect(s.safeParse({ start: 'a', end: 'b' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pre-call egress cap via the dispatcher (REQ-9.5) — code + bucket, no fetch
// ---------------------------------------------------------------------------

const BASE = { userId: 'owner-1', conversationId: 'c1' };

function snapshot(over: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
  return { toolUse: true, consent: true, hasUwKey: true, ...over };
}
function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    turnSignal: new AbortController().signal,
    perToolController: new AbortController(),
    registry: toolRegistry,
    ...over,
  };
}
function callFor(name: string, args: unknown = {}): ToolCall {
  return { id: 'tc-1', name, arguments: args };
}

describe('trade-data pre-call egress cap (REQ-9.5)', () => {
  it('consent gating: TOOL_NOT_PERMITTED when consent is off (no fetch)', async () => {
    const result = await dispatchTool(
      callFor('trade_data_open_positions'),
      BASE,
      snapshot({ consent: false }),
      createTurnState(),
      deps(),
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('TOOL_NOT_PERMITTED');
      expect(bucketOf(result.code)).toBe('tool_result');
    }
    expect(selectOpenPositionsSummary).not.toHaveBeenCalled();
  });

  it('trips TRADE_DATA_BUDGET_EXCEEDED with code+bucket and does NOT fetch/charge', async () => {
    const ts = createTurnState();
    ts.tradeDataTokens = TRADE_DATA_EGRESS_CAP - 1000; // remaining 1000 < 3000 bound

    const result = await dispatchTool(
      callFor('trade_data_open_positions'),
      BASE,
      snapshot(),
      ts,
      deps(),
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('TRADE_DATA_BUDGET_EXCEEDED');
      expect(bucketOf(result.code)).toBe('tool_result');
    }
    // No fetch, no persist, no charge (REQ-9.5).
    expect(selectOpenPositionsSummary).not.toHaveBeenCalled();
    expect(ts.tradeDataTokens).toBe(TRADE_DATA_EGRESS_CAP - 1000);
    // Not counted as a degenerate failure.
    expect(ts.totalDegenerateFailures).toBe(0);
  });

  it('charges the exact maxEstTokens only on a successful call', async () => {
    const ts = createTurnState();
    const result = await dispatchTool(
      callFor('trade_data_account_summary'),
      BASE,
      snapshot(),
      ts,
      deps(),
    );
    expect(result.status).toBe('ok');
    expect(selectAccountSummaries).toHaveBeenCalledWith(expect.anything(), 'owner-1');
    expect(ts.tradeDataTokens).toBe(2000);
  });
});

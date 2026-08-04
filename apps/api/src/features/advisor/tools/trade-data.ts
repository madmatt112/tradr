// Opt-in trade-data tools (design §Component 7, REQ-9).
//
// Four read-only tools backed by the user's OWN trade history. All are
// `category:'trade-data'`, `requires:'trade-data-consent'` (REQ-1.7), and carry
// a STATIC `maxEstTokens` worst-case egress bound the dispatcher enforces as a
// deterministic pre-call cap (REQ-9.5, dispatch.ts step 5):
//
//   trade_data_open_positions  → 3000
//   trade_data_recent_closed   → 1500
//   trade_data_account_summary → 2000
//   trade_data_pnl_summary     →  800
//
// account_summary was raised 1500 → 2000 when the cash/position split
// (ledger-balances Req 10) added `cash` and `positionValue` to every account
// row — five fields became seven, so the worst-case payload grew with it. The
// bound is a budget declaration, not a truncation limit, so leaving it at 1500
// would have quietly under-charged the per-turn trade-data budget.
//
// Trade-data contexts carry NO Unusual Whales client (REQ-1.4): handlers read
// the `db` singleton and run the task-14 summary queries scoped to `ctx.userId`
// (REQ-9.4) — no tool can read another user's data, write, or touch
// credentials/sessions. Each query is already capped + compacted, so the
// persisted `tool_result` stays small.
//
// Inputs are flat Zod objects validated by the dispatcher BEFORE any handler
// runs; handlers re-parse defensively so they are safe in isolation.

import { z } from 'zod';

import { GranularitySchema, PerformanceQuerySchema } from '@tradr/shared';

import { db } from '@/db';
import { selectAccountSummaries } from '@/features/accounts/accounts.query';
import { getPerformance } from '@/features/performance/performance.service';
import {
  selectOpenPositionsSummary,
  selectRecentClosedSummary,
  RECENT_CLOSED_SUMMARY_CAP,
} from '@/features/positions/positions.query';

import { TOOL_RESULT_CODES } from './error-codes';
import type { ToolDefinition, ToolResult } from './types';

// --- Static egress bounds (REQ-9.5; exact values pinned by the design) -------

const OPEN_POSITIONS_MAX_EST_TOKENS = 3000;
const RECENT_CLOSED_MAX_EST_TOKENS = 1500;
const ACCOUNT_SUMMARY_MAX_EST_TOKENS = 2000;
const PNL_SUMMARY_MAX_EST_TOKENS = 800;

// --- Input schemas (flat objects; scalar fields only) ------------------------

const emptyInputSchema = z.object({});

const recentClosedInputSchema = z.object({
  limit: z.number().int().min(1).max(RECENT_CLOSED_SUMMARY_CAP).optional(),
});

/** Flat P&L inputs forwarded to `getPerformance` (REQ-9 §Component 7). */
const pnlSummaryInputSchema = z.object({
  granularity: GranularitySchema,
  start: z.string(),
  end: z.string(),
  tz: z.string().optional(),
  currency: z.string().optional(),
});

// --- Tool definitions --------------------------------------------------------

export const openPositionsTool: ToolDefinition = {
  name: 'trade_data_open_positions',
  description:
    "Get a summary of the user's own currently-open positions (symbol, side, account; capped at 50).",
  category: 'trade-data',
  requires: 'trade-data-consent',
  maxEstTokens: OPEN_POSITIONS_MAX_EST_TOKENS,
  inputSchema: emptyInputSchema,
  async handler(input, ctx): Promise<ToolResult> {
    emptyInputSchema.parse(input);
    const positions = await selectOpenPositionsSummary(db, ctx.userId);
    return { status: 'ok', content: { count: positions.length, positions } };
  },
};

export const recentClosedTool: ToolDefinition = {
  name: 'trade_data_recent_closed',
  description:
    "Get a summary of the user's own most-recently-closed positions (limit 1-20, default 20).",
  category: 'trade-data',
  requires: 'trade-data-consent',
  maxEstTokens: RECENT_CLOSED_MAX_EST_TOKENS,
  inputSchema: recentClosedInputSchema,
  async handler(input, ctx): Promise<ToolResult> {
    const { limit } = recentClosedInputSchema.parse(input);
    const positions = await selectRecentClosedSummary(
      db,
      ctx.userId,
      limit ?? RECENT_CLOSED_SUMMARY_CAP,
    );
    return { status: 'ok', content: { count: positions.length, positions } };
  },
};

export const accountSummaryTool: ToolDefinition = {
  name: 'trade_data_account_summary',
  description:
    "Get a summary of the user's own trading accounts. Each account reports its balance " +
    'split into cash (deployable funds) and positionValue (open positions at COST BASIS, ' +
    'not market value — there is no quote feed). positionValue is negative for short ' +
    'positions, where the unexited size is proceeds received against shares still owed. ' +
    'cash + positionValue always equals balance.',
  category: 'trade-data',
  requires: 'trade-data-consent',
  maxEstTokens: ACCOUNT_SUMMARY_MAX_EST_TOKENS,
  inputSchema: emptyInputSchema,
  async handler(input, ctx): Promise<ToolResult> {
    emptyInputSchema.parse(input);
    const accounts = await selectAccountSummaries(db, ctx.userId);
    return { status: 'ok', content: { count: accounts.length, accounts } };
  },
};

export const pnlSummaryTool: ToolDefinition = {
  name: 'trade_data_pnl_summary',
  description:
    "Get the user's own profit-and-loss summary over a date range (per-currency stats: net P&L, win rate, profit factor). granularity is one of day/week/month/year; start and end are ISO dates.",
  category: 'trade-data',
  requires: 'trade-data-consent',
  maxEstTokens: PNL_SUMMARY_MAX_EST_TOKENS,
  inputSchema: pnlSummaryInputSchema,
  async handler(input, ctx): Promise<ToolResult> {
    // Bound the requested window with the SAME schema the HTTP route uses
    // (MIN_START / date order / end<=today+1 / BUCKET_COUNT_CAP) so the tool
    // path can't drive getPerformance into an unbounded synchronous bucket loop.
    // The dispatcher already shape-validated against pnlSummaryInputSchema.
    const bounded = PerformanceQuerySchema.safeParse(input);
    if (!bounded.success) {
      return {
        status: 'error',
        code: TOOL_RESULT_CODES.TOOL_INPUT_INVALID,
        message: bounded.error.issues[0]?.message ?? 'Invalid P&L date range.',
      };
    }
    const result = await getPerformance(db, ctx.userId, bounded.data, ctx.signal, Date.now());
    // Compact projection — only the per-currency stats, not the full series.
    const currencies = result.currencies.map((c) => ({ code: c.code, stats: c.stats }));
    return {
      status: 'ok',
      content: {
        resolvedTimezone: result.resolvedTimezone,
        defaultCurrency: result.defaultCurrency,
        hasAnyClosedPositions: result.hasAnyClosedPositions,
        currencies,
      },
    };
  },
};

/** All four trade-data tools, for registry wiring (REQ-9). */
export const tradeDataTools: ToolDefinition[] = [
  openPositionsTool,
  recentClosedTool,
  accountSummaryTool,
  pnlSummaryTool,
];

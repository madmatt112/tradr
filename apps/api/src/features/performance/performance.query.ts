import { sql } from 'drizzle-orm';

import { CURRENCY_CODES } from '@tradr/shared';

import type { Database, Transaction } from '@/db';

// Advisor trade-data P&L summary (advisor-tools §Component 7, REQ-9.4, REQ-9.7):
// the trade_data_pnl_summary tool reuses `performance.service.getPerformance`
// directly (a self-contained, read-only `repeatable read` transaction that is
// already userId-scoped). No separate compact-projection query is added here —
// duplicating getPerformance's classification/aggregation would diverge from
// the rest of the app and importing the service here would create a cycle.

export interface SnapshotFill {
  type: string;
  price: string;
  quantity: string;
  fees: string;
  /** Needed to date each realization event (bucket B). */
  filledAt: string;
}

export interface SnapshotPosition {
  id: string;
  side: string;
  assetType: string;
  currency: string;
  /**
   * NULL for a position that is not currently flat. Such positions still
   * contribute their realized P&L to bucket-B metrics via their fills; they are
   * excluded from the flat-only bucket-A statistics.
   */
  closedAt: string | null;
  status: string;
  fills: SnapshotFill[];
}

export interface TimeframeSnapshot {
  positions: SnapshotPosition[];
  timeframeExcluded: {
    total: number;
    unsupported: number;
    mismatch: number;
  };
}

export interface HistoryCurrency {
  code: string;
  earliestClosedAt: string;
  mostRecentClosedAt: string;
  totalClosedPositions: number;
}

export interface HistoryMetadata {
  currencies: HistoryCurrency[];
  hasAnyAccounts: boolean;
  hasAnyClosedPositions: boolean;
  hasAnyClosedPositionsInSupportedCurrency: boolean;
  historyExcluded: {
    total: number;
    closed_at_null: number;
  };
}

export async function fetchTimeframeSnapshot(
  tx: Database | Transaction,
  userId: string,
  startInstant: Date,
  endInstant: Date,
): Promise<TimeframeSnapshot> {
  // postgres-js binds a JS array as a row composite (`record`), not as
  // `text[]`, so `${arr}::text[]` fails. Build a postgres array literal
  // string (`{USD,EUR,...}`) and cast that. CURRENCY_CODES are hardcoded
  // 3-letter constants — no injection surface.
  const supported = `{${(CURRENCY_CODES as readonly string[]).join(',')}}`;
  const result = await tx.execute<{ envelope: TimeframeSnapshot }>(sql`
    WITH closed AS (
      -- Positions RELEVANT to the window, which is no longer the same as
      -- "closed in the window": a partial exit realizes P&L while the position
      -- stays open (bucket B), so any position with a fill in the window
      -- qualifies too. The service splits the two populations — see
      -- performance.service.ts §buckets. Fee-schedule columns are gone: fees
      -- come from fills.fees and are never re-applied at read time.
      SELECT DISTINCT
        p.id, p.side, p.asset_type, p.closed_at, p.status,
        a.currency
      FROM positions p
      JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
      WHERE p.user_id = ${userId}
        AND a.currency = ANY(${supported}::text[])
        AND (
          (
            p.status = 'closed'
            AND p.closed_at IS NOT NULL
            AND p.closed_at >= ${startInstant.toISOString()}
            AND p.closed_at <  ${endInstant.toISOString()}
          )
          OR EXISTS (
            SELECT 1 FROM fills f
            WHERE f.position_id = p.id
              AND f.filled_at >= ${startInstant.toISOString()}
              AND f.filled_at <  ${endInstant.toISOString()}
          )
        )
    ),
    position_fills AS (
      SELECT
        f.position_id,
        jsonb_agg(
          jsonb_build_object(
            'type', f.type, 'price', f.price::text,
            'quantity', f.quantity::text, 'fees', f.fees::text,
            'filledAt', f.filled_at
          ) ORDER BY f.filled_at
        ) AS fills
      FROM fills f
      JOIN closed c ON c.id = f.position_id
      GROUP BY f.position_id
    ),
    timeframe_excluded AS (
      SELECT DISTINCT p.id,
        (a.currency <> ALL(${supported}::text[])) AS is_unsupported_currency,
        (a.user_id <> p.user_id)                  AS is_user_id_mismatch
      FROM positions p
      JOIN accounts a ON a.id = p.account_id
      WHERE p.user_id = ${userId}
        AND p.status = 'closed'
        AND p.closed_at IS NOT NULL
        AND p.closed_at >= ${startInstant.toISOString()}
        AND p.closed_at <  ${endInstant.toISOString()}
        AND (a.currency <> ALL(${supported}::text[]) OR a.user_id <> p.user_id)
    ),
    timeframe_summary AS (
      SELECT
        COUNT(*) FILTER (WHERE is_unsupported_currency OR is_user_id_mismatch) AS total,
        COUNT(*) FILTER (WHERE is_unsupported_currency)                        AS unsupported,
        COUNT(*) FILTER (WHERE is_user_id_mismatch)                            AS mismatch
      FROM timeframe_excluded
    )
    SELECT jsonb_build_object(
      'positions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', c.id, 'side', c.side, 'assetType', c.asset_type,
          'currency', c.currency, 'closedAt', c.closed_at, 'status', c.status,
          'fills', COALESCE(pf.fills, '[]'::jsonb)
        ))
        FROM closed c LEFT JOIN position_fills pf ON pf.position_id = c.id
      ), '[]'::jsonb),
      'timeframeExcluded', (SELECT jsonb_build_object(
        'total',       total,
        'unsupported', unsupported,
        'mismatch',    mismatch
      ) FROM timeframe_summary)
    ) AS envelope
  `);

  return result[0].envelope;
}

export async function fetchHistoryMetadata(
  tx: Database | Transaction,
  userId: string,
): Promise<HistoryMetadata> {
  const supported = `{${(CURRENCY_CODES as readonly string[]).join(',')}}`;
  const result = await tx.execute<{ envelope: HistoryMetadata }>(sql`
    WITH closed_full_supported AS (
      SELECT p.id, p.closed_at, a.currency
      FROM positions p
      JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
      WHERE p.user_id = ${userId} AND p.status = 'closed' AND p.closed_at IS NOT NULL
            AND a.currency = ANY(${supported}::text[])
    ),
    -- Currency DISCOVERY must include positions that have realized P&L without
    -- being flat: a user whose only activity is partial exits has zero closed
    -- positions, and keying the currency list on closed_full_supported alone
    -- would return no currencies at all — hiding bucket-B data entirely.
    -- The historyRange aggregates below stay closed-only (they describe closed
    -- positions), hence the FILTER clauses.
    realized_full_supported AS (
      SELECT p.id, p.closed_at, a.currency,
             (p.status = 'closed' AND p.closed_at IS NOT NULL) AS is_flat
      FROM positions p
      JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
      WHERE p.user_id = ${userId}
        AND a.currency = ANY(${supported}::text[])
        AND (
          (p.status = 'closed' AND p.closed_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM fills f WHERE f.position_id = p.id AND f.type = 'exit')
        )
    ),
    per_currency AS (
      SELECT
        currency,
        MIN(closed_at) FILTER (WHERE is_flat)  AS earliest_closed_at,
        MAX(closed_at) FILTER (WHERE is_flat)  AS most_recent_closed_at,
        COUNT(*)       FILTER (WHERE is_flat)  AS total_closed_positions
      FROM realized_full_supported
      GROUP BY currency
    ),
    any_accounts AS (
      SELECT EXISTS (SELECT 1 FROM accounts WHERE user_id = ${userId}) AS has
    ),
    any_closed_unfiltered AS (
      SELECT EXISTS (
        SELECT 1 FROM positions p
        JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
        WHERE p.user_id = ${userId} AND p.status = 'closed' AND p.closed_at IS NOT NULL
      ) AS has
    ),
    any_closed_supported AS (
      SELECT EXISTS (SELECT 1 FROM closed_full_supported) AS has
    ),
    history_null_closed AS (
      SELECT COUNT(*) AS total
      FROM positions p
      WHERE p.user_id = ${userId} AND p.status = 'closed' AND p.closed_at IS NULL
    )
    SELECT jsonb_build_object(
      'currencies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'code',                 currency,
        'earliestClosedAt',     earliest_closed_at,
        'mostRecentClosedAt',   most_recent_closed_at,
        'totalClosedPositions', total_closed_positions
      ) ORDER BY currency) FROM per_currency), '[]'::jsonb),
      'hasAnyAccounts',                            (SELECT has FROM any_accounts),
      'hasAnyClosedPositions',                     (SELECT has FROM any_closed_unfiltered),
      'hasAnyClosedPositionsInSupportedCurrency',  (SELECT has FROM any_closed_supported),
      'historyExcluded', (SELECT jsonb_build_object(
        'total',          total,
        'closed_at_null', total
      ) FROM history_null_closed)
    ) AS envelope
  `);

  return result[0].envelope;
}

import type { PositionCompliance } from '@tradr/shared/schemas/trading-rule';

import type { Database } from '@/db';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger';

import { buildScoringContext, scorePosition } from './rule-evaluator';
import { loadScoringData } from './trading-rules.query';

// The unscored fallback for a position that could not be scored. `finality`
// tracks the position's own state — provisional while open, final once closed,
// null for a draft — so the shape reads the same as a real score minus the
// numbers (design C6, D19).
function unscored(status: string): PositionCompliance {
  return {
    finality: status === 'open' ? 'provisional' : status === 'draft' ? null : 'final',
    score: null,
    status: 'unscored',
    entries: [],
  };
}

/**
 * The compliance for one position, computed on read (design C6). Returns:
 *
 * - `undefined` when the user holds no rules, so the detail omits the field and
 *   the web tells "no rules" from "rules exist" (Requirement 6.1);
 * - the draft shape (null finality, null score, no entries) for a draft (D19);
 * - otherwise the loaded population scored by the pure evaluator, inside one
 *   `repeatable read`, `read only` transaction.
 *
 * Scoring never fails its caller (Requirement 5.2): a throw is logged with the
 * position id and the position comes back unscored, so the read still succeeds.
 */
export async function getPositionCompliance(
  db: Database,
  userId: string,
  positionId: string,
  status: string,
): Promise<PositionCompliance | undefined> {
  try {
    return await db.transaction(
      async (tx) => {
        const data = await loadScoringData(tx, userId, [positionId]);
        if (data.rules.length === 0) return undefined;
        if (status === 'draft') {
          return { finality: null, score: null, status: 'unscored', entries: [] };
        }
        const ctx = buildScoringContext(data, config.WEEK_START_DAY);
        return scorePosition(ctx, positionId);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch (error) {
    logger.error('trading_rules_scoring_failed', { positionId, error });
    return unscored(status);
  }
}

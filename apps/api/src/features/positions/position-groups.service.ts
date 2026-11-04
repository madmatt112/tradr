import { MAX_GROUP_LEGS, validateLegSet } from '@tradr/shared/lib/strategy';
import type { CreatePositionGroupInput, LinkPositionsInput } from '@tradr/shared/schemas/position';

import type { Database, Transaction } from '@/db';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  dissolveGroupIfSingleton,
  findGroupLegIds,
  findPositionGroupById,
  insertPositionGroup,
  lockGroupLegs,
  lockLegs,
  setPositionGroupLink,
  updateGroupLabelOverride,
} from './position-groups.query';
import { isAccountDemo } from './positions.query';
import {
  addFillTx,
  assertPositionCreateAllowed,
  createPositionTx,
  getPositionGroupEntry,
  openPositionTx,
} from './positions.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawRow = Record<string, any>;

function missingIdError(ids: string[], rows: RawRow[]): NotFoundError {
  const foundIds = new Set(rows.map((r) => r.id));
  const missing = ids.find((id) => !foundIds.has(id)) ?? ids[0]!;
  return new NotFoundError('Position', missing);
}

/**
 * Validates and links an already-locked, already-ordered leg set: foreign id
 * (caller's job, via `missingIdError`), draft, already grouped, differing
 * account, then `validateLegSet` — design.md C4 `linkPositionsTx` and Error
 * Handling 1/2/3.
 */
function assertLinkable(ordered: RawRow[], alreadyMemberOf?: string): void {
  for (const row of ordered) {
    if (row.status === 'draft') {
      throw new ConflictError(`Cannot link a draft position (${row.symbol})`);
    }
  }
  for (const row of ordered) {
    // `addGroupLeg` passes its own group id here so the group's current
    // members — already carrying it — don't trip their own "already
    // grouped" check; only the candidate (never a member of it yet) can.
    if (row.group_id && row.group_id !== alreadyMemberOf) {
      throw new ConflictError(`${row.symbol} is already in a group`);
    }
  }
  const firstAccountId = ordered[0]!.account_id;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.account_id !== firstAccountId) {
      throw new ValidationError(`Leg ${i + 1} differs in account from the group's.`, {
        legIndex: String(i),
      });
    }
  }
  const fault = validateLegSet(
    ordered.map((row) => ({ symbol: row.symbol, assetType: row.asset_type })),
  );
  if (fault) {
    throw new ValidationError(fault.message, { legIndex: String(fault.index) });
  }
}

/**
 * Every group leg write except close-all (design C4, C5). `createPositionGroup`
 * and `linkPositions` own their transaction; `linkPositionsTx` is the bare
 * tx-accepting core CSV import's group-commit step (C10) also calls.
 */
export async function createPositionGroup(
  db: Database,
  userId: string,
  data: CreatePositionGroupInput,
  gate: { isAdmin: boolean },
) {
  const fault = validateLegSet(data.legs);
  if (fault) {
    throw new ValidationError(fault.message, { legIndex: String(fault.index) });
  }

  const groupId = await withTransaction(db, async (tx) => {
    await assertPositionCreateAllowed(tx, userId, data.accountId, data.legs.length, gate);

    const [group] = await insertPositionGroup(tx, {
      userId,
      labelOverride: data.labelOverride ?? null,
    });

    for (const leg of data.legs) {
      const position = await createPositionTx(
        tx,
        userId,
        { accountId: data.accountId, symbol: leg.symbol, side: leg.side, assetType: leg.assetType },
        group!.id,
      );
      await addFillTx(tx, position.id, userId, {
        type: 'entry',
        price: leg.price,
        quantity: leg.quantity,
        fees: leg.fees,
        filledAt: data.filledAt,
      });
      await openPositionTx(tx, position.id, userId, data.filledAt);
    }

    return group!.id;
  });

  // Fire-and-forget, AFTER commit, once per leg (requirements D16 — no new
  // events). Same best-effort guard as `createPosition`'s single event: a
  // telemetry fault, or a concurrently-deleted account, skips every event
  // rather than firing a partial set.
  try {
    const isDemo = await isAccountDemo(db, userId, data.accountId);
    for (const leg of data.legs) {
      captureServerEvent('position_created', {
        distinctId: userId,
        properties: { assetType: leg.assetType, isDemo },
      });
    }
  } catch {
    // ignore — capture is fire-and-forget
  }

  const entry = await getPositionGroupEntry(db, userId, groupId);
  if (entry === null) throw new NotFoundError('Position group', groupId);
  return entry;
}

/**
 * Links already-locked ids, in the id-list's own order (not the lock's
 * ascending pass), into a new group (design C4). No group exists yet, so
 * this locks the raw input ids via `lockLegs` rather than `lockGroupLegs`.
 */
export async function linkPositionsTx(
  tx: Transaction,
  userId: string,
  positionIds: string[],
  labelOverride?: string | null,
): Promise<string> {
  const rows = await lockLegs(tx, userId, positionIds);
  if (rows.length !== new Set(positionIds).size) {
    throw missingIdError(positionIds, rows);
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = positionIds.map((id) => byId.get(id)!);
  assertLinkable(ordered);

  const [group] = await insertPositionGroup(tx, { userId, labelOverride: labelOverride ?? null });
  for (const row of ordered) {
    await setPositionGroupLink(tx, row.id, group!.id);
  }
  return group!.id;
}

export async function linkPositions(db: Database, userId: string, data: LinkPositionsInput) {
  const groupId = await withTransaction(db, (tx) =>
    linkPositionsTx(tx, userId, data.positionIds, data.labelOverride ?? null),
  );
  const entry = await getPositionGroupEntry(db, userId, groupId);
  if (entry === null) throw new NotFoundError('Position group', groupId);
  return entry;
}

/**
 * Adds one leg to an existing group (design C4): locks the union of the
 * group's current legs and the candidate, ascending, in one pass (the Lock
 * rule), re-reads membership, then applies the 8-leg limit (Error Handling
 * #8) and the same checks as `linkPositionsTx`.
 */
export async function addGroupLeg(
  db: Database,
  userId: string,
  groupId: string,
  positionId: string,
) {
  await withTransaction(db, async (tx) => {
    const groupRows = await findPositionGroupById(tx, groupId, userId);
    if (groupRows.length === 0) throw new NotFoundError('Position group', groupId);

    const initialLegIds = await findGroupLegIds(tx, groupId);
    const unionIds = [...new Set([...initialLegIds, positionId])];
    const rows = await lockLegs(tx, userId, unionIds);
    if (rows.length !== unionIds.length) {
      throw missingIdError(unionIds, rows);
    }

    const rereadLegIds = await findGroupLegIds(tx, groupId);
    if (
      rereadLegIds.length !== initialLegIds.length ||
      rereadLegIds.some((id, i) => id !== initialLegIds[i])
    ) {
      throw new ConflictError('The group changed; try again.');
    }
    if (rereadLegIds.length >= MAX_GROUP_LEGS) {
      throw new ValidationError(`A group can hold at most ${MAX_GROUP_LEGS} legs.`);
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
    const candidate = byId.get(positionId)!;
    const currentRows = rereadLegIds.map((id) => byId.get(id)!);
    assertLinkable([...currentRows, candidate], groupId);

    await setPositionGroupLink(tx, positionId, groupId);
  });

  const entry = await getPositionGroupEntry(db, userId, groupId);
  if (entry === null) throw new NotFoundError('Position group', groupId);
  return entry;
}

/**
 * Unlinks one leg (design C4): locks and re-verifies the group's current
 * membership, clears the leg's link, then dissolves the group into a plain
 * position once one leg or fewer remains (AC 1.5).
 */
export async function unlinkGroupLeg(
  db: Database,
  userId: string,
  groupId: string,
  positionId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const groupRows = await findPositionGroupById(tx, groupId, userId);
    if (groupRows.length === 0) throw new NotFoundError('Position group', groupId);

    const rows = await lockGroupLegs(tx, userId, groupId);
    if (!rows.some((row) => row.id === positionId)) {
      throw new NotFoundError('Position', positionId);
    }

    await setPositionGroupLink(tx, positionId, null);
    await dissolveGroupIfSingleton(tx, groupId, userId);
  });
}

/**
 * Sets or clears a group's label override (design C4, Requirement 2.4).
 * `position_groups` is never row-locked (D5); the ownership-scoped `UPDATE`
 * is itself the existence/ownership check — zero rows means a foreign or
 * nonexistent group (NFR Security).
 */
export async function setGroupLabel(
  db: Database,
  userId: string,
  groupId: string,
  labelOverride: string | null,
) {
  const updated = await updateGroupLabelOverride(db, groupId, userId, labelOverride);
  if (updated.length === 0) throw new NotFoundError('Position group', groupId);

  const entry = await getPositionGroupEntry(db, userId, groupId);
  if (entry === null) throw new NotFoundError('Position group', groupId);
  return entry;
}

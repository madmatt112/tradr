import type { Database } from '@/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

interface PgError {
  code?: string;
  constraint_name?: string;
  detail?: string;
}
function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

import {
  findBrokeragesByUser,
  findBrokerageById,
  insertBrokerage,
  updateBrokerage,
  updateFeeSchedule,
  deleteBrokerage,
  findAccountsByBrokerage,
  duplicateBrokerageQuery,
  countPositionsByBrokerage,
} from './brokerages.query';

export async function listBrokerages(db: Database, userId: string) {
  return findBrokeragesByUser(db, userId);
}

export async function getBrokerage(db: Database, id: string, userId: string) {
  const brokerage = await findBrokerageById(db, id, userId);
  if (!brokerage) throw new NotFoundError('Brokerage', id);
  return brokerage;
}

export async function createBrokerage(
  db: Database,
  userId: string,
  data: { name: string; notes?: string | null },
) {
  return withTransaction(db, async (tx) => {
    try {
      return await insertBrokerage(tx, { userId, ...data });
    } catch (err: unknown) {
      if (isPgError(err) && err.code === '23505') {
        throw new ConflictError('A brokerage with this name already exists');
      }
      throw err;
    }
  });
}

export async function editBrokerage(
  db: Database,
  id: string,
  userId: string,
  data: {
    name?: string;
    notes?: string | null;
    feeSchedule?: Partial<{
      stockPerShareCommission: string;
      stockMinPerFill: string;
      stockMaxPerFill: string;
      optionsPerContractCommission: string;
      optionsPerContractExchangeFee: string;
      optionsMinPerFill: string;
      optionsMaxPerFill: string;
    }>;
  },
) {
  return withTransaction(db, async (tx) => {
    const existing = await findBrokerageById(tx, id, userId);
    if (!existing) throw new NotFoundError('Brokerage', id);
    if (existing.isSystem) throw new ForbiddenError('System brokerages cannot be modified');

    // Validate min/max constraints on fee schedule
    if (data.feeSchedule) {
      const merged = { ...existing.feeSchedule, ...data.feeSchedule };
      validateMinMax(merged, 'Stock', 'stockMinPerFill', 'stockMaxPerFill');
      validateMinMax(merged, 'Options', 'optionsMinPerFill', 'optionsMaxPerFill');
    }

    const { feeSchedule, ...brokerageData } = data;
    const brokerageFields: Partial<{ name: string; notes: string | null }> = {};
    if (brokerageData.name !== undefined) brokerageFields.name = brokerageData.name;
    if (brokerageData.notes !== undefined) brokerageFields.notes = brokerageData.notes;

    try {
      if (Object.keys(brokerageFields).length > 0) {
        await updateBrokerage(tx, id, brokerageFields);
      }
      if (feeSchedule && Object.keys(feeSchedule).length > 0) {
        await updateFeeSchedule(tx, id, feeSchedule);
      }
    } catch (err: unknown) {
      if (isPgError(err) && err.code === '23505') {
        throw new ConflictError('A brokerage with this name already exists');
      }
      throw err;
    }

    return findBrokerageById(tx, id, userId);
  });
}

export async function removeBrokerage(db: Database, id: string, userId: string) {
  return withTransaction(db, async (tx) => {
    const existing = await findBrokerageById(tx, id, userId);
    if (!existing) throw new NotFoundError('Brokerage', id);
    if (existing.isSystem) throw new ForbiddenError('System brokerages cannot be deleted');

    const referencingAccounts = await findAccountsByBrokerage(tx, id, userId);
    if (referencingAccounts.length > 0) {
      const names = referencingAccounts.map((a) => a.name).join(', ');
      throw new ConflictError(`Cannot delete brokerage while assigned to accounts: ${names}`);
    }

    await deleteBrokerage(tx, id);
  });
}

export async function duplicateBrokerage(db: Database, id: string, userId: string) {
  return withTransaction(db, async (tx) => {
    try {
      const result = await duplicateBrokerageQuery(tx, id, userId);
      if (!result) throw new NotFoundError('Brokerage', id);
      return result;
    } catch (err: unknown) {
      if (isPgError(err) && err.code === '23505') {
        throw new ConflictError(
          'A brokerage with this name already exists — rename your existing one first',
        );
      }
      throw err;
    }
  });
}

export async function getPositionCountByBrokerage(
  db: Database,
  brokerageId: string,
  userId: string,
) {
  const [{ count }] = await countPositionsByBrokerage(db, brokerageId, userId);
  return count;
}

function validateMinMax(
  schedule: Record<string, unknown>,
  label: string,
  minKey: string,
  maxKey: string,
) {
  const min = parseFloat(String(schedule[minKey] ?? '0'));
  const max = parseFloat(String(schedule[maxKey] ?? '0'));
  if (max > 0 && min > max) {
    throw new ValidationError(
      `${label} max per fill ($${max.toFixed(2)}) must be ≥ min per fill ($${min.toFixed(2)})`,
    );
  }
}

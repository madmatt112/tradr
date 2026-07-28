import Decimal from 'decimal.js';
import { eq, and, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { accounts, brokerages, feeSchedules, positions } from '@/db/schema';

// Drizzle's relational queries use json_build_object under the hood, which casts
// numeric columns to JSON numbers; .insert().returning() keeps them as strings.
// Normalize to Decimal-stringified form so the API response shape is consistent.
const FEE_FIELDS = [
  'stockPerShareCommission',
  'stockMinPerFill',
  'stockMaxPerFill',
  'optionsPerContractCommission',
  'optionsPerContractExchangeFee',
  'optionsMinPerFill',
  'optionsMaxPerFill',
] as const;

function normalizeFeeSchedule<T extends Record<string, unknown> | null | undefined>(
  schedule: T,
): T {
  if (!schedule) return schedule;
  const out = { ...schedule } as Record<string, unknown>;
  for (const f of FEE_FIELDS) {
    if (f in out && out[f] != null) out[f] = new Decimal(out[f] as string | number).toString();
  }
  return out as T;
}

function normalizeBrokerage<T extends { feeSchedule?: unknown } | null | undefined>(b: T): T {
  if (!b) return b;
  return { ...b, feeSchedule: normalizeFeeSchedule(b.feeSchedule as Record<string, unknown>) } as T;
}

export async function findBrokeragesByUser(db: Database | Transaction, userId: string) {
  const rows = await db.query.brokerages.findMany({
    where: or(eq(brokerages.userId, userId), eq(brokerages.isSystem, true)),
    with: { feeSchedule: true },
    orderBy: [brokerages.name],
  });
  return rows.map(normalizeBrokerage);
}

export async function findBrokerageById(db: Database | Transaction, id: string, userId: string) {
  const row = await db.query.brokerages.findFirst({
    where: and(
      eq(brokerages.id, id),
      or(eq(brokerages.userId, userId), eq(brokerages.isSystem, true)),
    ),
    with: { feeSchedule: true },
  });
  return normalizeBrokerage(row);
}

export async function insertBrokerage(
  tx: Transaction,
  data: { userId: string; name: string; notes?: string | null },
) {
  const [brokerage] = await tx
    .insert(brokerages)
    .values({ userId: data.userId, name: data.name, notes: data.notes ?? null })
    .returning();

  const [feeSchedule] = await tx
    .insert(feeSchedules)
    .values({ brokerageId: brokerage.id })
    .returning();

  return { ...brokerage, feeSchedule: normalizeFeeSchedule(feeSchedule) };
}

export function updateBrokerage(
  tx: Transaction,
  id: string,
  data: Partial<{ name: string; notes: string | null }>,
) {
  return tx
    .update(brokerages)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(brokerages.id, id))
    .returning();
}

export function updateFeeSchedule(
  tx: Transaction,
  brokerageId: string,
  data: Partial<{
    stockPerShareCommission: string;
    stockMinPerFill: string;
    stockMaxPerFill: string;
    optionsPerContractCommission: string;
    optionsPerContractExchangeFee: string;
    optionsMinPerFill: string;
    optionsMaxPerFill: string;
  }>,
) {
  return tx
    .update(feeSchedules)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(feeSchedules.brokerageId, brokerageId))
    .returning();
}

export function deleteBrokerage(tx: Transaction, id: string) {
  return tx.delete(brokerages).where(eq(brokerages.id, id)).returning();
}

export function findAccountsByBrokerage(
  db: Database | Transaction,
  brokerageId: string,
  userId: string,
) {
  return db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.brokerageId, brokerageId), eq(accounts.userId, userId)));
}

export async function duplicateBrokerageQuery(tx: Transaction, sourceId: string, userId: string) {
  const source = await tx.query.brokerages.findFirst({
    where: and(
      eq(brokerages.id, sourceId),
      or(eq(brokerages.userId, userId), eq(brokerages.isSystem, true)),
    ),
    with: { feeSchedule: true },
  });

  if (!source) return null;

  const [newBrokerage] = await tx
    .insert(brokerages)
    .values({ userId, name: source.name, notes: source.notes })
    .returning();

  const [newFeeSchedule] = await tx
    .insert(feeSchedules)
    .values({
      brokerageId: newBrokerage.id,
      stockPerShareCommission: String(source.feeSchedule?.stockPerShareCommission ?? '0'),
      stockMinPerFill: String(source.feeSchedule?.stockMinPerFill ?? '0'),
      stockMaxPerFill: String(source.feeSchedule?.stockMaxPerFill ?? '0'),
      optionsPerContractCommission: String(source.feeSchedule?.optionsPerContractCommission ?? '0'),
      optionsPerContractExchangeFee: String(
        source.feeSchedule?.optionsPerContractExchangeFee ?? '0',
      ),
      optionsMinPerFill: String(source.feeSchedule?.optionsMinPerFill ?? '0'),
      optionsMaxPerFill: String(source.feeSchedule?.optionsMaxPerFill ?? '0'),
    })
    .returning();

  return { ...newBrokerage, feeSchedule: normalizeFeeSchedule(newFeeSchedule) };
}

export function countPositionsByBrokerage(
  db: Database | Transaction,
  brokerageId: string,
  userId: string,
) {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(positions)
    .innerJoin(accounts, eq(positions.accountId, accounts.id))
    .where(and(eq(accounts.brokerageId, brokerageId), eq(accounts.userId, userId)));
}

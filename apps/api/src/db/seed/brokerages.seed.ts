import { eq } from 'drizzle-orm';

import type { Database } from '@/db';
import { accounts, brokerages, feeSchedules } from '@/db/schema';

export async function seedBrokerages(db: Database, userId: string) {
  // High Fee Broker
  const [highFee] = await db
    .insert(brokerages)
    .values({ userId, name: 'High Fee Broker' })
    .returning();

  await db.insert(feeSchedules).values({
    brokerageId: highFee.id,
    stockPerShareCommission: '0.01',
    stockMinPerFill: '4.95',
    stockMaxPerFill: '9.95',
    optionsPerContractCommission: '1.25',
    optionsPerContractExchangeFee: '0.30',
    optionsMinPerFill: '4.95',
    optionsMaxPerFill: '0',
  });

  // Low Fee Broker
  const [lowFee] = await db
    .insert(brokerages)
    .values({ userId, name: 'Low Fee Broker' })
    .returning();

  await db.insert(feeSchedules).values({
    brokerageId: lowFee.id,
    stockPerShareCommission: '0.001',
    stockMinPerFill: '0.50',
    stockMaxPerFill: '1.00',
    optionsPerContractCommission: '0.50',
    optionsPerContractExchangeFee: '0.05',
    optionsMinPerFill: '0',
    optionsMaxPerFill: '0',
  });

  // Custom Options Broker — zero stock fees, custom options fees
  const [customOptions] = await db
    .insert(brokerages)
    .values({ userId, name: 'Custom Options Broker' })
    .returning();

  await db.insert(feeSchedules).values({
    brokerageId: customOptions.id,
    stockPerShareCommission: '0',
    stockMinPerFill: '0',
    stockMaxPerFill: '0',
    optionsPerContractCommission: '0.65',
    optionsPerContractExchangeFee: '0.15',
    optionsMinPerFill: '1.00',
    optionsMaxPerFill: '12.50',
  });

  // Assign the first brokerage to the first seeded account
  const userAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .limit(1);

  if (userAccounts.length > 0) {
    await db
      .update(accounts)
      .set({ brokerageId: highFee.id })
      .where(eq(accounts.id, userAccounts[0].id));
  }

  return { highFee, lowFee, customOptions };
}

import type { Database } from '@/db';
import { dashboardLayouts, users } from '@/db/schema';
import { buildDefaultLayout } from '@/features/dashboard/dashboard.service';
import { logger } from '@/lib/logger';

export async function dashboardSeed(db: Database): Promise<void> {
  const allUsers = await db.select({ id: users.id }).from(users);

  let seeded = 0;
  for (const { id: userId } of allUsers) {
    const widgets = await buildDefaultLayout(userId);
    const result = await db
      .insert(dashboardLayouts)
      .values({ userId, widgets })
      .onConflictDoNothing()
      .returning({ userId: dashboardLayouts.userId });
    seeded += result.length;
  }

  logger.info('Dashboard layouts seeded', { count: seeded });
}

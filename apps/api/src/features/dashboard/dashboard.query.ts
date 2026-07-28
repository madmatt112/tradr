import { eq, sql } from 'drizzle-orm';

import type { Theme, WidgetPlacement } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { dashboardLayouts, users } from '@/db/schema';

export async function selectLayoutAndTheme(
  db: Database | Transaction,
  userId: string,
): Promise<{
  widgets: WidgetPlacement[] | null;
  updatedAt: string | null;
  theme: Theme;
}> {
  const rows = await db
    .select({
      widgets: dashboardLayouts.widgets,
      updatedAt: dashboardLayouts.updatedAt,
      theme: sql<Theme>`${users.theme}`,
    })
    .from(users)
    .leftJoin(dashboardLayouts, eq(dashboardLayouts.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    // Caller is responsible for handling missing user; mirror DB shape.
    return { widgets: null, updatedAt: null, theme: 'system' };
  }

  return {
    widgets: row.widgets ?? null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    theme: row.theme,
  };
}

export async function upsertLayout(
  tx: Transaction,
  userId: string,
  widgets: WidgetPlacement[],
): Promise<{ widgets: WidgetPlacement[]; updatedAt: string }> {
  const rows = await tx
    .insert(dashboardLayouts)
    .values({ userId, widgets })
    .onConflictDoUpdate({
      target: dashboardLayouts.userId,
      set: { widgets, updatedAt: new Date() },
    })
    .returning({
      widgets: dashboardLayouts.widgets,
      updatedAt: dashboardLayouts.updatedAt,
    });

  const row = rows[0];
  return {
    widgets: row.widgets,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function updateUserTheme(
  tx: Transaction,
  userId: string,
  theme: Theme,
): Promise<{ theme: Theme } | null> {
  const rows = await tx
    .update(users)
    .set({ theme, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ theme: sql<Theme>`${users.theme}` });

  const row = rows[0];
  return row ? { theme: row.theme } : null;
}

export async function selectUserTheme(
  db: Database | Transaction,
  userId: string,
): Promise<{ theme: Theme } | null> {
  const rows = await db
    .select({ theme: sql<Theme>`${users.theme}` })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  return row ? { theme: row.theme } : null;
}

export async function selectLayout(
  tx: Transaction,
  userId: string,
): Promise<{ widgets: WidgetPlacement[]; updatedAt: string } | null> {
  const rows = await tx
    .select({
      widgets: dashboardLayouts.widgets,
      updatedAt: dashboardLayouts.updatedAt,
    })
    .from(dashboardLayouts)
    .where(eq(dashboardLayouts.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    widgets: row.widgets,
    updatedAt: row.updatedAt.toISOString(),
  };
}

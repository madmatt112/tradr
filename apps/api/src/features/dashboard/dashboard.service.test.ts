import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DEFAULT_WIDGETS, type WidgetPlacement } from '@tradr/shared';

import { db } from '@/db';
import { dashboardLayouts, users } from '@/db/schema';
import { UnauthorizedError } from '@/lib/errors';
import * as transactionLib from '@/lib/transaction';

import * as dashboardQuery from './dashboard.query';
import {
  buildDefaultLayout,
  clearDashboardCache,
  getLayoutForUser,
  initDashboardCache,
  putLayoutForUser,
} from './dashboard.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
function uniqueEmail(): string {
  return `dash-svc-${Date.now()}-${++counter}@example.com`;
}

async function seedUser(): Promise<{ id: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: uniqueEmail(),
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  return { id: user!.id };
}

async function seedLayoutRow(
  userId: string,
  widgets: WidgetPlacement[],
): Promise<{ updatedAt: string }> {
  const [row] = await db.insert(dashboardLayouts).values({ userId, widgets }).returning();
  return { updatedAt: row!.updatedAt.toISOString() };
}

beforeEach(() => {
  clearDashboardCache();
  initDashboardCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearDashboardCache();
});

describe('dashboard.service', () => {
  it('buildDefaultLayout: second call returns same array reference (cache hit)', async () => {
    const { id } = await seedUser();
    const first = await buildDefaultLayout(id);
    const second = await buildDefaultLayout(id);
    expect(second).toBe(first);
  });

  it('buildDefaultLayout: deterministic IDs across two calls for the same userId', async () => {
    const { id } = await seedUser();
    const first = await buildDefaultLayout(id);
    clearDashboardCache();
    initDashboardCache();
    const second = await buildDefaultLayout(id);
    expect(second.map((w) => w.id)).toEqual(first.map((w) => w.id));
    expect(second.length).toBe(DEFAULT_WIDGETS.length);
  });

  it('buildDefaultLayout: different userId values produce different ID sets', async () => {
    const a = await seedUser();
    const b = await seedUser();
    const wa = await buildDefaultLayout(a.id);
    const wb = await buildDefaultLayout(b.id);
    const idsA = new Set(wa.map((w) => w.id));
    const idsB = new Set(wb.map((w) => w.id));
    for (const id of idsA) expect(idsB.has(id)).toBe(false);
  });

  it('initDashboardCache: second call is a no-op (existing cache retained)', async () => {
    const { id } = await seedUser();
    const first = await buildDefaultLayout(id);
    initDashboardCache({ max: 1 }); // second init — must be no-op
    const second = await buildDefaultLayout(id);
    expect(second).toBe(first); // still hits the original cache
  });

  it('getLayoutForUser: with no layout row returns default layout and updatedAt:null', async () => {
    const { id } = await seedUser();
    const res = await getLayoutForUser(id);
    expect(res.updatedAt).toBeNull();
    expect(res.widgets.length).toBe(DEFAULT_WIDGETS.length);
    expect(res.theme).toBe('system');
  });

  it('getLayoutForUser: with a row returns the row widgets and updatedAt', async () => {
    const { id } = await seedUser();
    const stored = await buildDefaultLayout(id);
    const { updatedAt } = await seedLayoutRow(id, stored);
    const res = await getLayoutForUser(id);
    expect(res.widgets.map((w) => w.id).sort()).toEqual(stored.map((w) => w.id).sort());
    expect(res.updatedAt).toBe(updatedAt);
  });

  it('putLayoutForUser: combined body updates both tables and returns both values', async () => {
    const { id } = await seedUser();
    const widgets = await buildDefaultLayout(id);
    const res = await putLayoutForUser(id, { widgets, theme: 'dark' });
    expect(res.theme).toBe('dark');
    expect(res.widgets.map((w) => w.id).sort()).toEqual(widgets.map((w) => w.id).sort());
    expect(res.updatedAt).not.toBeNull();

    const layoutRow = await db
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, id));
    expect(layoutRow).toHaveLength(1);
    const userRow = await db.select().from(users).where(eq(users.id, id));
    expect(userRow[0].theme).toBe('dark');
  });

  it('putLayoutForUser: widgets-only re-reads users.theme for the response (§N)', async () => {
    const { id } = await seedUser();
    await db.update(users).set({ theme: 'light' }).where(eq(users.id, id));
    const widgets = await buildDefaultLayout(id);
    const res = await putLayoutForUser(id, { widgets });
    expect(res.theme).toBe('light');
    expect(res.updatedAt).not.toBeNull();
    // users.theme was not touched by the write path
    const userRow = await db.select().from(users).where(eq(users.id, id));
    expect(userRow[0].theme).toBe('light');
  });

  it('putLayoutForUser: theme-only with no existing layout row returns default widgets, updatedAt:null, and does NOT insert (§J(a))', async () => {
    const { id } = await seedUser();
    const res = await putLayoutForUser(id, { theme: 'dark' });
    expect(res.theme).toBe('dark');
    expect(res.updatedAt).toBeNull();
    expect(res.widgets.length).toBe(DEFAULT_WIDGETS.length);

    const layoutRow = await db
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, id));
    expect(layoutRow).toHaveLength(0);
  });

  it('putLayoutForUser: theme-only with existing layout row returns existing widgets/updatedAt, row NOT rewritten (§J(b))', async () => {
    const { id } = await seedUser();
    const widgets = await buildDefaultLayout(id);
    const { updatedAt: originalUpdatedAt } = await seedLayoutRow(id, widgets);
    // Wait a tick so any rewrite would be visible as a different timestamp.
    await new Promise((r) => setTimeout(r, 10));
    const res = await putLayoutForUser(id, { theme: 'dark' });
    expect(res.theme).toBe('dark');
    expect(res.updatedAt).toBe(originalUpdatedAt);
    expect(res.widgets.map((w) => w.id).sort()).toEqual(widgets.map((w) => w.id).sort());

    const layoutRow = await db
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, id));
    expect(layoutRow[0].updatedAt.toISOString()).toBe(originalUpdatedAt);
  });

  it('putLayoutForUser: rollback — failure mid-transaction leaves both tables unmutated', async () => {
    const { id } = await seedUser();
    const widgets = await buildDefaultLayout(id);

    // Force the second statement (theme update) to throw AFTER widgets upsert.
    const themeSpy = vi
      .spyOn(dashboardQuery, 'updateUserTheme')
      .mockRejectedValueOnce(new Error('boom'));

    await expect(putLayoutForUser(id, { widgets, theme: 'dark' })).rejects.toThrow('boom');

    // dashboard_layouts must be empty (upsert rolled back).
    const layoutRow = await db
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, id));
    expect(layoutRow).toHaveLength(0);

    // users.theme must remain the default ('system').
    const userRow = await db.select().from(users).where(eq(users.id, id));
    expect(userRow[0].theme).toBe('system');

    themeSpy.mockRestore();
  });

  it('putLayoutForUser: FK violation 23503 is re-thrown as UnauthorizedError (§I)', async () => {
    const { id } = await seedUser();
    const widgets = await buildDefaultLayout(id);

    const pgErr = Object.assign(new Error('foreign key violation'), {
      code: '23503',
    });
    const txSpy = vi.spyOn(transactionLib, 'withTransaction').mockRejectedValueOnce(pgErr);

    await expect(putLayoutForUser(id, { widgets })).rejects.toBeInstanceOf(UnauthorizedError);

    txSpy.mockRestore();
  });
});

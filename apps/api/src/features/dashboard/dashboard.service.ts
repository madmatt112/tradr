import {
  DEFAULT_WIDGETS,
  WIDGET_DEFAULT_NAMESPACE,
  reconcileStoredLayout,
  uuidv5Batch,
  type DashboardLayoutResponse,
  type PutDashboardLayoutRequest,
  type Theme,
  type WidgetPlacement,
} from '@tradr/shared';

import { db } from '@/db';
import { UnauthorizedError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

import {
  selectLayout,
  selectLayoutAndTheme,
  selectUserTheme,
  updateUserTheme,
  upsertLayout,
} from './dashboard.query';

// ---------------------------------------------------------------------------
// LRU cache — Map insertion-order trick. Inline, no dep.
// ---------------------------------------------------------------------------

class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

let initialized = false;
let cache: LruCache<string, WidgetPlacement[]> | null = null;

export function initDashboardCache(opts?: { max?: number }): void {
  if (initialized) return;
  cache = new LruCache<string, WidgetPlacement[]>(opts?.max ?? 2000);
  initialized = true;
}

export function clearDashboardCache(): void {
  initialized = false;
  cache = null;
}

function ensureCache(): LruCache<string, WidgetPlacement[]> {
  if (!cache) {
    initDashboardCache();
  }
  return cache!;
}

// ---------------------------------------------------------------------------
// Pg error helper (matches accounts.service.ts precedent).
// ---------------------------------------------------------------------------

function isPgError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

// ---------------------------------------------------------------------------
// Service exports
// ---------------------------------------------------------------------------

export async function buildDefaultLayout(userId: string): Promise<WidgetPlacement[]> {
  const c = ensureCache();
  const hit = c.get(userId);
  if (hit) return hit;

  const ids = await uuidv5Batch(
    DEFAULT_WIDGETS.map((w) => `${userId}:${w.type}`),
    WIDGET_DEFAULT_NAMESPACE,
  );
  // Build a NEW array; never mutate DEFAULT_WIDGETS.
  const widgets: WidgetPlacement[] = DEFAULT_WIDGETS.map((w, i) => ({
    id: ids[i],
    type: w.type,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
  }));
  c.set(userId, widgets);
  return widgets;
}

/**
 * EVERY stored layout leaves this service reconciled — see
 * `reconcileStoredLayout`. A row is written once and read forever, so raising a
 * pinned default or a per-type minimum reaches nobody who has ever arranged
 * their dashboard unless the read does it; and because the client PUTs what it
 * was given, a response that carried stale geometry is what made the next add,
 * remove or timeframe change 400 against the bound it fails.
 *
 * The row itself is left alone. This is idempotent and runs on a layout of at
 * most six widgets, so repairing on read costs nothing worth writing for, and a
 * GET has no business mutating. The user's next real save persists it.
 */
export async function getLayoutForUser(userId: string): Promise<DashboardLayoutResponse> {
  const { widgets, updatedAt, theme } = await selectLayoutAndTheme(db, userId);
  if (widgets === null) {
    const defaults = await buildDefaultLayout(userId);
    return { widgets: defaults, theme, updatedAt: null };
  }
  return { widgets: reconcileStoredLayout(widgets), theme, updatedAt };
}

export async function getThemeForUser(userId: string): Promise<Theme> {
  const row = await selectUserTheme(db, userId);
  return row?.theme ?? 'system';
}

export async function putLayoutForUser(
  userId: string,
  input: PutDashboardLayoutRequest,
): Promise<DashboardLayoutResponse> {
  try {
    return await withTransaction(db, async (tx) => {
      let widgetsOut: WidgetPlacement[] | null = null;
      let updatedAtOut: string | null = null;
      let themeOut: Theme | null = null;

      // LOCK ORDER (write-path): dashboard_layouts → users; see design.md §M
      if (input.widgets !== undefined) {
        const row = await upsertLayout(tx, userId, input.widgets);
        widgetsOut = row.widgets;
        updatedAtOut = row.updatedAt;
      }
      if (input.theme !== undefined) {
        const row = await updateUserTheme(tx, userId, input.theme);
        themeOut = row?.theme ?? input.theme;
      }

      // §N: re-read only the OTHER (un-written) field for the response.
      if (themeOut === null) {
        const t = await selectUserTheme(tx, userId);
        themeOut = t?.theme ?? 'system';
      }
      if (widgetsOut === null) {
        // §J: theme-only write — do NOT insert a layout row. Read existing
        // (if any), otherwise return the user-scoped default layout with
        // updatedAt:null.
        const existing = await selectLayout(tx, userId);
        if (existing) {
          // Same reconciliation as the GET. A theme-only write answers with the
          // stored layout it did not touch, and the endpoint may only have ONE
          // answer to "what is this user's layout" — a caller that took this
          // one would be handed exactly the geometry the GET repairs.
          widgetsOut = reconcileStoredLayout(existing.widgets);
          updatedAtOut = existing.updatedAt;
        } else {
          widgetsOut = await buildDefaultLayout(userId);
          updatedAtOut = null;
        }
      }

      return { widgets: widgetsOut, theme: themeOut, updatedAt: updatedAtOut };
    });
  } catch (err) {
    if (isPgError(err, '23503')) {
      throw new UnauthorizedError('Session no longer valid');
    }
    throw err;
  }
}

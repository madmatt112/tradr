import { describe, expect, it } from 'vitest';

import {
  DashboardLayoutResponseSchema,
  GRID_MAX_ROWS,
  PutDashboardLayoutRequestSchema,
  WidgetPlacementSchema,
} from './dashboard';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';
const UUID_E = '55555555-5555-4555-8555-555555555555';
const UUID_F = '66666666-6666-4666-8666-666666666666';
const UUID_G = '77777777-7777-4777-8777-777777777777';

// Canonical six-widget default layout that satisfies all refinements.
function canonicalWidgets() {
  return [
    { id: UUID_A, type: 'stats-summary' as const, x: 0, y: 0, w: 12, h: 2 },
    { id: UUID_B, type: 'performance-chart' as const, x: 0, y: 2, w: 6, h: 6 },
    { id: UUID_C, type: 'equity-curve' as const, x: 0, y: 8, w: 6, h: 4 },
    { id: UUID_D, type: 'account-balances' as const, x: 6, y: 2, w: 6, h: 4 },
    { id: UUID_E, type: 'position-sizing' as const, x: 6, y: 6, w: 6, h: 6 },
    { id: UUID_F, type: 'open-positions' as const, x: 0, y: 12, w: 12, h: 4 },
  ];
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('PutDashboardLayoutRequestSchema refinements', () => {
  // 1. max-length: 7 widgets rejects with .max(6)
  it('rejects 7 widgets via the .max(6) constraint', () => {
    const widgets = [
      ...canonicalWidgets(),
      { id: UUID_G, type: 'stats-summary' as const, x: 0, y: 8, w: 4, h: 1 },
    ];
    const result = PutDashboardLayoutRequestSchema.safeParse({ widgets });
    expect(result.success).toBe(false);
  });

  // 2. type uniqueness via checkUniqueTypes
  it('rejects two stats-summary placements (checkUniqueTypes)', () => {
    const widgets = [
      { id: UUID_A, type: 'stats-summary' as const, x: 0, y: 0, w: 12, h: 1 },
      { id: UUID_B, type: 'stats-summary' as const, x: 0, y: 2, w: 12, h: 1 },
    ];
    const result = PutDashboardLayoutRequestSchema.safeParse({ widgets });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /Duplicate widget type/.test(i.message))).toBe(true);
    }
  });

  // 3. x + w bound
  it('rejects placement where x+w > 12 ({x:10, w:3})', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'stats-summary',
      x: 10,
      y: 0,
      w: 3,
      h: 1,
    });
    expect(result.success).toBe(false);
  });

  // 4. h .max(GRID_MAX_ROWS)
  it('rejects h past GRID_MAX_ROWS, and accepts exactly GRID_MAX_ROWS', () => {
    const at = (h: number) =>
      WidgetPlacementSchema.safeParse({
        id: UUID_A,
        type: 'stats-summary',
        x: 0,
        y: 0,
        w: 12,
        h,
      }).success;
    // The bound moved with the row unit (80px -> 40px, Req 1.10) so the
    // reachable pixel height is unchanged; a full-page widget is 24 rows.
    expect(GRID_MAX_ROWS).toBe(24);
    expect(at(GRID_MAX_ROWS)).toBe(true);
    expect(at(GRID_MAX_ROWS + 1)).toBe(false);
  });

  // 5. h .min(1)
  it('rejects h: 0 via the schema .min(1)', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'stats-summary',
      x: 0,
      y: 0,
      w: 12,
      h: 0,
    });
    expect(result.success).toBe(false);
  });

  // 6. per-widget min w (open-positions w:3)
  it('rejects open-positions at w:3 (per-widget min w is 4)', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'open-positions',
      x: 0,
      y: 0,
      w: 3,
      h: 2,
    });
    expect(result.success).toBe(false);
  });

  // 7. per-widget min h (position-sizing h:2)
  it('rejects position-sizing at h:2 (per-widget min h is 3)', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'position-sizing',
      x: 0,
      y: 0,
      w: 3,
      h: 2,
    });
    expect(result.success).toBe(false);
  });

  // 8. overlapping rectangles via checkNoOverlap
  it('rejects two overlapping placements (checkNoOverlap)', () => {
    const widgets = [
      { id: UUID_A, type: 'stats-summary' as const, x: 0, y: 0, w: 6, h: 2 },
      { id: UUID_B, type: 'open-positions' as const, x: 3, y: 1, w: 6, h: 2 },
    ];
    const result = PutDashboardLayoutRequestSchema.safeParse({ widgets });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /overlap/i.test(i.message))).toBe(true);
    }
  });

  // 9. .strict() rejects unknown placement key
  it('rejects unknown placement key via .strict()', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'stats-summary',
      x: 0,
      y: 0,
      w: 12,
      h: 1,
      foo: 'bar',
    });
    expect(result.success).toBe(false);
  });

  // 10. .strict() rejects unknown top-level key
  it('rejects unknown top-level body key via .strict()', () => {
    const result = PutDashboardLayoutRequestSchema.safeParse({
      theme: 'light',
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });

  // 11. empty body rejects
  it('rejects empty body with "body must contain at least one of …"', () => {
    const result = PutDashboardLayoutRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /at least one of/.test(i.message))).toBe(true);
    }
  });

  // 12. theme allowlist
  it("rejects theme 'magenta' (not in allowlist)", () => {
    const result = PutDashboardLayoutRequestSchema.safeParse({ theme: 'magenta' });
    expect(result.success).toBe(false);
  });

  // 13. per-widget 2KB config cap (over)
  it('rejects a placement whose config JSON exceeds 2048 chars', () => {
    const big = { blob: 'x'.repeat(2100) };
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'stats-summary',
      x: 0,
      y: 0,
      w: 12,
      h: 1,
      config: big,
    });
    expect(result.success).toBe(false);
  });

  // 14. per-widget 2KB cap accepts empty config
  it('accepts a placement with empty config', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'stats-summary',
      x: 0,
      y: 0,
      w: 12,
      h: 2,
      config: {},
    });
    expect(result.success).toBe(true);
  });

  // 15. canonical six-widget input accepts
  it('accepts the canonical six-widget default-shape input', () => {
    const result = PutDashboardLayoutRequestSchema.safeParse({
      widgets: canonicalWidgets(),
    });
    expect(result.success).toBe(true);
  });

  // 16. widgets-only body accepts
  it('accepts a widgets-only body', () => {
    const result = PutDashboardLayoutRequestSchema.safeParse({
      widgets: canonicalWidgets(),
    });
    expect(result.success).toBe(true);
  });

  // 17. theme-only body accepts
  it('accepts a theme-only body', () => {
    const result = PutDashboardLayoutRequestSchema.safeParse({ theme: 'dark' });
    expect(result.success).toBe(true);
  });

  // 18. combined body accepts
  it('accepts a combined widgets + theme body', () => {
    const result = PutDashboardLayoutRequestSchema.safeParse({
      widgets: canonicalWidgets(),
      theme: 'system',
    });
    expect(result.success).toBe(true);
  });

  // 19. UUID validation
  it('rejects invalid id "not-a-uuid"', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: 'not-a-uuid',
      type: 'stats-summary',
      x: 0,
      y: 0,
      w: 12,
      h: 1,
    });
    expect(result.success).toBe(false);
  });

  // 20. x: -1
  it('rejects x: -1 via .min(0)', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'stats-summary',
      x: -1,
      y: 0,
      w: 12,
      h: 1,
    });
    expect(result.success).toBe(false);
  });

  // 21. x: 12
  it('rejects x: 12 via .max(11)', () => {
    const result = WidgetPlacementSchema.safeParse({
      id: UUID_A,
      type: 'stats-summary',
      x: 12,
      y: 0,
      w: 1,
      h: 1,
    });
    expect(result.success).toBe(false);
  });

  // 22. response schema: updatedAt null accepts
  it('accepts updatedAt: null on DashboardLayoutResponseSchema', () => {
    const result = DashboardLayoutResponseSchema.safeParse({
      widgets: canonicalWidgets(),
      theme: 'light',
      updatedAt: null,
    });
    expect(result.success).toBe(true);
  });
});

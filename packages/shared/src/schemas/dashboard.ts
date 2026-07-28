import { z } from 'zod';

export const WidgetTypeSchema = z.enum([
  'stats-summary',
  'open-positions',
  'performance-chart',
  'account-balances',
  'position-sizing',
  'equity-curve',
]);
export type WidgetType = z.infer<typeof WidgetTypeSchema>;

export const ThemeSchema = z.enum(['light', 'dark', 'system']);
export type Theme = z.infer<typeof ThemeSchema>;

// Canonical per-widget minimum sizes (per design §F). The frontend widget
// registry imports from here, not vice versa.
export const PerWidgetMinSize: Record<WidgetType, { w: number; h: number }> = {
  'stats-summary': { w: 4, h: 1 },
  'open-positions': { w: 4, h: 2 },
  'performance-chart': { w: 4, h: 2 },
  'account-balances': { w: 3, h: 2 },
  'position-sizing': { w: 3, h: 3 },
  'equity-curve': { w: 4, h: 2 },
};

export const WidgetPlacementSchema = z
  .object({
    id: z.string().uuid(),
    type: WidgetTypeSchema,
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(6),
    config: z.unknown().optional(),
  })
  .strict()
  .refine((p) => p.x + p.w <= 12, {
    message: 'Widget extends past 12-column grid (x + w must be <= 12)',
  })
  .refine((p) => p.w >= PerWidgetMinSize[p.type].w && p.h >= PerWidgetMinSize[p.type].h, {
    message: 'Widget is smaller than the minimum size for its type',
  })
  .refine((p) => JSON.stringify(p.config ?? {}).length <= 2048, {
    message: 'Widget config exceeds 2048 bytes',
  });

export type WidgetPlacement = z.infer<typeof WidgetPlacementSchema>;

// Refinement helpers — exported for reuse in tests / other schemas.
export function checkUniqueTypes(arr: WidgetPlacement[], ctx: z.RefinementCtx): void {
  const seen = new Set<WidgetType>();
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i].type;
    if (seen.has(t)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate widget type: ${t}`,
        path: [i, 'type'],
      });
    }
    seen.add(t);
  }
}

// O(n²); n ≤ 6 → at most 15 comparisons.
export function checkNoOverlap(arr: WidgetPlacement[], ctx: z.RefinementCtx): void {
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i];
      const b = arr[j];
      const overlapsX = a.x < b.x + b.w && b.x < a.x + a.w;
      const overlapsY = a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlapsX && overlapsY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Widgets overlap (indices ${i} and ${j})`,
          path: [j],
        });
      }
    }
  }
}

export const DashboardLayoutResponseSchema = z
  .object({
    widgets: z.array(WidgetPlacementSchema).max(WidgetTypeSchema.options.length),
    theme: ThemeSchema,
    updatedAt: z.string().nullable(),
  })
  .strict();

export type DashboardLayoutResponse = z.infer<typeof DashboardLayoutResponseSchema>;

export const PutDashboardLayoutRequestSchema = z
  .object({
    widgets: z
      .array(WidgetPlacementSchema)
      .max(WidgetTypeSchema.options.length)
      .superRefine(checkUniqueTypes)
      .superRefine(checkNoOverlap)
      .optional(),
    theme: ThemeSchema.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.widgets === undefined && b.theme === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'body must contain at least one of widgets or theme',
      });
    }
  });

export type PutDashboardLayoutRequest = z.infer<typeof PutDashboardLayoutRequestSchema>;

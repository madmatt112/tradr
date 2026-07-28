import { z } from 'zod';

// Wire-side validation contract for the options tools.
//
// Per design.md §Component 4 (Topic K closure):
//   - Schemas operate on numbers only — no `z.coerce.number()`, no `z.preprocess`.
//   - The form-side string→number conversion lives in an explicit adapter
//     (see apps/web/src/features/options/lib/formToWireInput.ts).
//   - `q` uses `.default(0)` directly (NOT `.optional().default(0)`); omitted
//     `q` substitutes 0 cleanly because no upstream coerce step can turn
//     undefined into NaN.

export const OccParseInputSchema = z.object({
  // Upper bound widened past the pure-function's 64-char cap so that
  // `OCC_TOO_LONG` (the pure-fn code, REQ-1.10) propagates through to the
  // wire envelope instead of being shadowed by Zod's `too_big`. Outer
  // hard-limit retained as a defence against megabyte payloads.
  input: z.string().min(1).max(256),
});

export const OccParseOutputSchema = z.object({
  underlying: z.string(),
  expiration: z.string(),
  type: z.enum(['call', 'put']),
  strike: z.string(),
});

export const OccEncodeInputSchema = z.object({
  underlying: z
    .string()
    .regex(/^[A-Z][A-Z.]{0,5}$/, 'underlying must be 1–6 chars, first character alpha'),
  expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiration must be YYYY-MM-DD'),
  type: z.enum(['call', 'put']),
  strike: z.string().min(1).max(16),
});

export const OccEncodeOutputSchema = z.object({
  symbol: z.string().length(21),
});

// Numbers only. No coerce. No preprocess.
export const BlackScholesInputSchema = z.object({
  S: z.number().finite().positive().max(1_000_000),
  K: z.number().finite().positive().max(1_000_000),
  T: z.number().finite().positive().max(50),
  sigma: z.number().finite().positive().max(5),
  r: z.number().finite().gte(-1).lte(1),
  q: z.number().finite().gte(0).lte(1).default(0),
  type: z.enum(['call', 'put']),
});

export const BlackScholesOutputSchema = z.object({
  price: z.string(),
  delta: z.string(),
  gamma: z.string(),
  thetaPerDay: z.string(),
  vegaPerPct: z.string(),
  rhoPerPct: z.string(),
});

// Inferred type aliases for the wire schemas above.
//
// `BlackScholesInput` / `BlackScholesOutput` are also declared as pure-function
// types in `packages/shared/src/options.ts`. The two shapes are structurally
// identical by design — the wire schema validates exactly what the pure
// function consumes — so per Task 7's resolution, the barrel re-exports the
// pure-function variants as the canonical `BlackScholesInput`/`BlackScholesOutput`
// and does NOT re-export the inferred aliases below. Consumers that need the
// schema-inferred form can either `z.infer<typeof BlackScholesInputSchema>` at
// the call site or import these aliases directly from
// `@tradr/shared/schemas/options`.
export type OccParseInput = z.infer<typeof OccParseInputSchema>;
export type OccParseOutput = z.infer<typeof OccParseOutputSchema>;
export type OccEncodeInput = z.infer<typeof OccEncodeInputSchema>;
export type OccEncodeOutput = z.infer<typeof OccEncodeOutputSchema>;
export type BlackScholesInput = z.infer<typeof BlackScholesInputSchema>;
export type BlackScholesOutput = z.infer<typeof BlackScholesOutputSchema>;

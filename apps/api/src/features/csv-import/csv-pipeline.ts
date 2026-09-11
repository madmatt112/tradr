import {
  CreateFillSchema,
  CreatePositionSchema,
  getCurrencyMinorUnits,
  type CsvPreviewRequest,
  type LocatedError,
  type LocatedWarning,
  type ProposedPosition,
} from '@tradr/shared';

import { aggregateFills, computePnlFromTotals } from '@/features/positions/pnl';
import {
  validateSegmentInvariants,
  type InMemoryFill,
} from '@/features/positions/segment-invariants';

import { resolveContracts } from './csv-contract';
import { applyMapping, validateMappingShape } from './csv-mapping';
import { normalizeRow, type NormalizedRow } from './csv-normalize';
import type { ParsedCsv } from './csv-parse';
import { segment, type Segment } from './csv-segment';

// ---------------------------------------------------------------------------
// Pure pipeline composition (design Component 5, seam 2) — the DB-free preview
// that the service and the conformance test both run. Composes the pure leaf
// modules (map → normalize → contract resolution → segment → per-segment
// validation + P&L) into one function that never touches `@/db`, `@/app`,
// `@/lib/config` or HTTP. Parse, the CSV_NO_ROWS refusal and the row-count guard
// stay in the service because they read `config`.
// ---------------------------------------------------------------------------

/** The DB-free preview result the service consumes (design Component 5). */
export interface PipelineResult {
  proposedPositions: ProposedPosition[];
  /** For the service's duplicate scan. */
  segments: Segment[];
  errors: LocatedError[];
  warnings: LocatedWarning[];
  totalFills: number;
}

/**
 * Run the pure preview pipeline (design Component 5): mapping shape → map +
 * transform → exclude mapping-errored rows → normalize → contract resolution →
 * segment → per-segment field validation, invariant dry-run and P&L. Collects
 * every located error/warning; NEVER throws on a mapping-shape error (those are
 * located to row 0 and the pipeline runs on).
 */
export function runPipeline(
  parsed: ParsedCsv,
  request: CsvPreviewRequest,
  accountCurrency: string,
): PipelineResult {
  const mapping = request.mapping;
  const errors: LocatedError[] = [];
  const warnings: LocatedWarning[] = [];

  // Mapping shape — reported before any row processing (REQ-2.4), located to
  // row 0. Collected and continued, never thrown.
  const mappingErrors = validateMappingShape(parsed.headers, mapping);
  for (const e of mappingErrors) {
    errors.push({
      rowNumber: 0,
      csvColumn: e.csvColumn,
      tradrField: e.tradrField,
      code: e.code,
      message: e.message,
    });
  }

  // Map + transform.
  const mapped = applyMapping(parsed, mapping);
  for (const e of mapped.errors) {
    errors.push({
      rowNumber: e.rowNumber,
      csvColumn: e.csvColumn,
      tradrField: e.tradrField,
      code: e.code,
      message: e.message,
    });
  }

  // Exclude every row whose sourceRow carries a mapping-level located error — a
  // missing required field, an unmatched transform cell (required or optional
  // alike), or a missing type/action — BEFORE normalization, contract resolution
  // and segmentation, exactly as a normalizeRow failure is dropped below. The
  // mapping error is what the user sees; the row is non-committable either way,
  // and dropping it keeps the segmenter from ever keying a scope on an absent
  // required cell (this closes the pre-existing empty-required-cell 500). The
  // membership Set is built once, so the pass stays O(rows).
  const errored = new Set(mapped.errors.map((e) => e.rowNumber));

  // Normalize each surviving row, collecting per-row located errors and warnings.
  const normalizedRows: NormalizedRow[] = [];
  for (const row of mapped.rows) {
    if (errored.has(row.sourceRow)) continue;
    const result = normalizeRow(row, {
      timezone: request.timezone,
      dateFormat: request.dateFormat,
      numberFormat: request.numberFormat,
      expiryFormat: mapping.expiryFormat,
      signedQuantity: mapping.signedQuantity,
      signedFees: mapping.signedFees,
    });
    if (Array.isArray(result)) {
      errors.push(...result);
      continue;
    }
    normalizedRows.push(result.row);
    warnings.push(...result.warnings);
  }

  // Contract resolution: rewrite each option row's symbol to the compact OCC
  // form (stock rows pass through); a row that errors is dropped.
  const resolved = resolveContracts(normalizedRows, {
    contractForm: mapping.contractForm,
    numberFormat: request.numberFormat,
    columns: mapping.columns,
  });
  errors.push(...resolved.errors);
  warnings.push(...resolved.warnings);

  // Segment.
  const segResult = segment(resolved.rows, mapping.rowShape);
  errors.push(...segResult.errors);
  warnings.push(...segResult.warnings);

  // Per-segment field validation + invariant dry-run + P&L.
  const proposedPositions: ProposedPosition[] = [];
  let totalFills = 0;
  for (const seg of segResult.segments) {
    validateSegment(seg, errors);
    proposedPositions.push(buildProposedPosition(seg, accountCurrency));
    totalFills += seg.executions.length;
  }

  return {
    proposedPositions,
    segments: segResult.segments,
    errors,
    warnings,
    totalFills,
  };
}

// ---------------------------------------------------------------------------
// Canonical UTC instant (moved from the service; imported back for dupKey)
// ---------------------------------------------------------------------------

/**
 * Canonical UTC instant (`…Z`) for a normalized ISO timestamp. The normalizer
 * emits offset form (`…+00:00`) for date-only inputs; `CreateFillSchema` uses
 * Zod `.datetime()` (offset-less, `Z`-only) and the DB stores a `timestamptz`
 * instant, so the preview validates/stores/dup-keys the same canonical instant
 * the commit will persist — keeping preview == commit fidelity.
 */
export function toInstant(iso: string): string {
  return new Date(iso).toISOString();
}

// ---------------------------------------------------------------------------
// Per-segment validation (field schema + invariants)
// ---------------------------------------------------------------------------

export function validateSegment(seg: Segment, errors: LocatedError[]): void {
  // Field validation against the shared schemas (normalized values, REQ-5.1).
  const positionCheck = CreatePositionSchema.safeParse({
    accountId: '00000000-0000-0000-0000-000000000000',
    symbol: seg.scope.symbol,
    side: seg.side,
    assetType: seg.scope.assetType,
  });
  if (!positionCheck.success) {
    const issue = positionCheck.error.issues[0];
    errors.push({
      rowNumber: seg.executions[0]?.sourceRow ?? 0,
      tradrField: 'symbol',
      code: 'FIELD_INVALID',
      message: issue.message,
    });
  }

  for (const exec of seg.executions) {
    const fillCheck = CreateFillSchema.safeParse({
      type: exec.type,
      price: exec.price,
      quantity: exec.quantity,
      fees: exec.fees,
      filledAt: toInstant(exec.filledAt),
    });
    if (!fillCheck.success) {
      for (const issue of fillCheck.error.issues) {
        errors.push({
          rowNumber: exec.sourceRow,
          tradrField: String(issue.path[0] ?? ''),
          code: 'FIELD_INVALID',
          message: issue.message,
        });
      }
    }
  }

  // Cross-fill invariant dry-run — the SAME predicates the live services run.
  const inMemory: InMemoryFill[] = seg.executions.map((e) => ({
    type: e.type,
    quantity: e.quantity,
    filledAt: e.filledAt,
  }));
  const openedAt = seg.executions[0]?.filledAt ?? null;
  const closedAt = seg.executions[seg.executions.length - 1]?.filledAt ?? null;
  const invariantErrors = validateSegmentInvariants(inMemory, {
    assetType: seg.scope.assetType === 'option' ? 'option' : 'stock',
    closes: seg.closes,
    openedAt,
    closedAt,
  });
  for (const ie of invariantErrors) {
    const rowNumber =
      ie.fillIndex !== null
        ? (seg.executions[ie.fillIndex]?.sourceRow ?? 0)
        : (seg.executions[0]?.sourceRow ?? 0);
    errors.push({ rowNumber, code: ie.code, message: ie.message });
  }
}

// ---------------------------------------------------------------------------
// Proposed-position P&L (reuses aggregateFills/computePnlFromTotals — no DB)
// ---------------------------------------------------------------------------

export function buildProposedPosition(seg: Segment, currency: string): ProposedPosition {
  const assetType = seg.scope.assetType === 'option' ? 'option' : 'stock';
  const totals = aggregateFills(
    seg.executions.map((e) => ({
      type: e.type,
      price: e.price,
      quantity: e.quantity,
      fees: e.fees,
    })),
  );
  const pnl = computePnlFromTotals(totals, seg.side, assetType, getCurrencyMinorUnits(currency));

  return {
    scope: { symbol: seg.scope.symbol, assetType },
    side: seg.side,
    closes: seg.closes,
    fills: seg.executions.map((e) => ({
      type: e.type,
      price: e.price,
      quantity: e.quantity,
      fees: e.fees,
      filledAt: toInstant(e.filledAt),
      sourceRow: e.sourceRow,
    })),
    proposedPnl: pnl.realizedPnl ?? undefined,
  };
}

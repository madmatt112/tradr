import type { RowShape } from '@tradr/shared';

/**
 * Target Tradr fields a CSV column can be mapped to, per row shape (design
 * Component 2 / REQ-2.2). `required` fields must be mapped before a preview can
 * run; the mapper marks them. The `execution` shape additionally requires
 * EXACTLY ONE of `type`/`action` — both are listed as optional here and the
 * mapper surfaces the "one of" rule; the server enforces it definitively.
 */
export interface TargetField {
  field: string;
  label: string;
  required: boolean;
}

const EXECUTION_FIELDS: TargetField[] = [
  { field: 'symbol', label: 'Symbol', required: true },
  { field: 'assetType', label: 'Asset type', required: true },
  { field: 'price', label: 'Price', required: true },
  { field: 'quantity', label: 'Quantity', required: true },
  { field: 'filledAt', label: 'Filled at (date/time)', required: true },
  // Exactly one of type | action is required (REQ-2.2) — server-enforced.
  { field: 'type', label: 'Type (entry/exit) — or map Action', required: false },
  { field: 'action', label: 'Action (buy/sell) — or map Type', required: false },
  { field: 'side', label: 'Side (long/short)', required: false },
  { field: 'fees', label: 'Fees', required: false },
  { field: 'notes', label: 'Notes', required: false },
];

const ROUND_TRIP_FIELDS: TargetField[] = [
  { field: 'symbol', label: 'Symbol', required: true },
  { field: 'assetType', label: 'Asset type', required: true },
  { field: 'side', label: 'Side (long/short)', required: true },
  { field: 'entryPrice', label: 'Entry price', required: true },
  { field: 'entryQuantity', label: 'Entry quantity', required: true },
  { field: 'entryDate', label: 'Entry date', required: true },
  { field: 'exitPrice', label: 'Exit price', required: true },
  { field: 'exitQuantity', label: 'Exit quantity', required: true },
  { field: 'exitDate', label: 'Exit date', required: true },
  { field: 'fees', label: 'Fees', required: false },
  { field: 'notes', label: 'Notes', required: false },
];

export function targetFieldsForShape(rowShape: RowShape): TargetField[] {
  return rowShape === 'round-trip' ? ROUND_TRIP_FIELDS : EXECUTION_FIELDS;
}

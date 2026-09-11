import type { ContractForm, Mapping, RowShape } from '@tradr/shared';

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

// Optional contract columns the `composed` option form offers on top of the
// base list (REQ-2.2). All optional — a stock-only file maps none of them, and
// `underlying` defaults to the Symbol column when unmapped.
const COMPOSED_CONTRACT_FIELDS: TargetField[] = [
  { field: 'underlying', label: 'Underlying (options; defaults to Symbol)', required: false },
  { field: 'expiry', label: 'Expiry (options)', required: false },
  { field: 'strike', label: 'Strike (options)', required: false },
  { field: 'right', label: 'Call/Put (options)', required: false },
];

// The `descriptor` form carries the whole contract in one preset-mapped column
// (REQ-2.1); the list surfaces it only so the preset's choice is visible.
const DESCRIPTOR_CONTRACT_FIELDS: TargetField[] = [
  { field: 'descriptor', label: 'Option descriptor (set by preset)', required: false },
];

/**
 * Preset-only mapping keys. The mapper never offers these fresh, but a preset
 * that set one must remain re-pointable or unmappable (REQ-4.1, REQ-5.4); the
 * field list adds a row for each key present in `mapping.columns`.
 */
export const PRESET_ONLY_LABELS: Record<string, string> = {
  descriptor: 'Option descriptor (set by preset)',
  multiplier: 'Multiplier (set by preset)',
  eventCode: 'Notes/Codes (set by preset)',
};

export function targetFieldsForShape(
  rowShape: RowShape,
  contractForm?: ContractForm,
): TargetField[] {
  const base = rowShape === 'round-trip' ? ROUND_TRIP_FIELDS : EXECUTION_FIELDS;
  if (contractForm === 'composed') return [...base, ...COMPOSED_CONTRACT_FIELDS];
  if (contractForm === 'descriptor') return [...base, ...DESCRIPTOR_CONTRACT_FIELDS];
  return base;
}

/**
 * Whether a required target field is satisfied by the current mapping.
 * `assetType` is exempt under the descriptor form once its descriptor column is
 * mapped — the preset derives the asset type from the descriptor, so no
 * asset-type column is needed (REQ-2.8 client half). Every other field is
 * satisfied only by a mapped column.
 */
export function isRequiredFieldSatisfied(field: string, mapping: Mapping): boolean {
  if (
    field === 'assetType' &&
    mapping.contractForm === 'descriptor' &&
    Boolean(mapping.columns.descriptor)
  ) {
    return true;
  }
  return Boolean(mapping.columns[field]);
}

import { CSV_IMPORT_PRESETS } from '@tradr/shared';
import type { DateFormat, Mapping, NumberFormat, RowShape } from '@tradr/shared';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { targetFieldsForShape } from '../lib/fields';

/**
 * Step 3 of the import flow (REQ-12.1/12.2): choose a preset or map columns by
 * hand, plus the per-import row shape, timezone, and date/number formats.
 *
 * The row-shape control is FIRST-CLASS and PRESET-INDEPENDENT (REQ-12.2): the
 * user can set it to `execution` (default) or `round-trip` without selecting any
 * preset, and changing it re-renders the target-field list. Because no shipped
 * preset is `round-trip` (Component 9), this selector is the ONLY path to a
 * round-trip import — so it must NOT be gated behind a preset selection. A preset
 * MAY set the shape, but the user can override it.
 */

const UNMAPPED = '__unmapped__';
const NO_PRESET = '__none__';

// A small, sensible timezone list defaulting to UTC (REQ-7.4). The field accepts
// any IANA tz string; this is the common set surfaced for correction.
const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
];

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: 'iso', label: 'ISO date (YYYY-MM-DD)' },
  { value: 'iso-datetime', label: 'ISO datetime (with time)' },
  { value: 'us', label: 'US (MM/DD/YYYY)' },
  { value: 'eu', label: 'EU (DD/MM/YYYY)' },
];

const NUMBER_FORMATS: { value: NumberFormat; label: string }[] = [
  { value: 'us', label: 'US (1,234.56)' },
  { value: 'eu', label: 'EU (1.234,56)' },
];

export interface ColumnMapperValue {
  presetId: string | null;
  rowShape: RowShape;
  mapping: Mapping;
  timezone: string;
  dateFormat: DateFormat;
  numberFormat: NumberFormat;
}

interface ColumnMapperProps {
  columns: string[];
  value: ColumnMapperValue;
  onChange: (next: ColumnMapperValue) => void;
}

export function ColumnMapper({ columns, value, onChange }: ColumnMapperProps) {
  const fields = targetFieldsForShape(value.rowShape);

  function applyPreset(presetId: string) {
    if (presetId === NO_PRESET) {
      onChange({ ...value, presetId: null });
      return;
    }
    const preset = CSV_IMPORT_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    // Preset auto-fills shape, formats, and mapping; the user can then adjust
    // anything — including overriding the row shape (REQ-12.2).
    onChange({
      ...value,
      presetId,
      rowShape: preset.rowShape,
      dateFormat: preset.dateFormat,
      numberFormat: preset.numberFormat,
      mapping: { ...preset.mapping, rowShape: preset.rowShape },
    });
  }

  function setRowShape(rowShape: RowShape) {
    // Preset-independent: changing the shape re-renders the field list and
    // carries the shape into the mapping. We keep existing column picks; fields
    // not in the new shape are simply not rendered.
    onChange({
      ...value,
      rowShape,
      mapping: { ...value.mapping, rowShape },
    });
  }

  function setColumn(field: string, column: string) {
    const nextColumns = { ...value.mapping.columns };
    if (column === UNMAPPED) {
      delete nextColumns[field];
    } else {
      nextColumns[field] = column;
    }
    onChange({ ...value, mapping: { ...value.mapping, columns: nextColumns } });
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="import-preset">Preset (optional)</Label>
          <Select value={value.presetId ?? NO_PRESET} onValueChange={applyPreset}>
            <SelectTrigger id="import-preset" className="w-full">
              <SelectValue placeholder="No preset" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PRESET}>No preset (map manually)</SelectItem>
              {CSV_IMPORT_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="import-row-shape">Row shape</Label>
          <Select value={value.rowShape} onValueChange={(v) => setRowShape(v as RowShape)}>
            <SelectTrigger id="import-row-shape" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="execution">Execution (one row per fill)</SelectItem>
              <SelectItem value="round-trip">Round-trip (one row per closed trade)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Set independently of any preset. Round-trip is available here even with no preset.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="import-timezone">Timezone</Label>
          <Select
            value={value.timezone}
            onValueChange={(tz) => onChange({ ...value, timezone: tz })}
          >
            <SelectTrigger id="import-timezone" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="import-date-format">Date format</Label>
          <Select
            value={value.dateFormat}
            onValueChange={(v) => onChange({ ...value, dateFormat: v as DateFormat })}
          >
            <SelectTrigger id="import-date-format" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_FORMATS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="import-number-format">Number format</Label>
          <Select
            value={value.numberFormat}
            onValueChange={(v) => onChange({ ...value, numberFormat: v as NumberFormat })}
          >
            <SelectTrigger id="import-number-format" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NUMBER_FORMATS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <Label>Map columns to fields</Label>
        <div className="space-y-2">
          {fields.map((target) => {
            const mapped = value.mapping.columns[target.field] ?? UNMAPPED;
            return (
              <div key={target.field} className="grid grid-cols-[1fr_1fr] items-center gap-3">
                <span className="text-sm">
                  {target.label}
                  {target.required && <span className="ml-1 text-destructive">*</span>}
                </span>
                <Select
                  value={columns.includes(mapped) ? mapped : UNMAPPED}
                  onValueChange={(col) => setColumn(target.field, col)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Not mapped" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNMAPPED}>Not mapped</SelectItem>
                    {columns.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          <span className="text-destructive">*</span> required. For execution rows, map exactly one
          of Type or Action.
        </p>
      </div>
    </div>
  );
}

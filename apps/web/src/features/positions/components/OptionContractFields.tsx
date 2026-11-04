import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import type { OptionContractInputs } from '../utils/occForm';

/**
 * Controlled, presentational block of the four guided option-contract inputs,
 * mirroring `OccCard.tsx`'s EncodeMode. Validation/encoding is the host dialog's
 * job (via `occForm`); this component only renders and emits changes.
 */
export interface OptionContractFieldsProps {
  value: OptionContractInputs;
  onChange: (next: OptionContractInputs) => void;
  /** Field-level errors plus a `form` slot for the rare non-field error. */
  errors?: Partial<Record<'underlying' | 'expiry' | 'strike' | 'form', string>>;
  /** Prefixes every input/error id, so a multi-leg row's ids stay distinct (task 17). */
  idPrefix?: string;
}

export function OptionContractFields({
  value,
  onChange,
  errors,
  idPrefix = 'occ',
}: OptionContractFieldsProps) {
  return (
    <div className="space-y-3">
      {errors?.form && (
        <p id={`${idPrefix}-form-error`} role="alert" className="text-sm text-destructive">
          {errors.form}
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-underlying`}>Underlying</Label>
        <Input
          id={`${idPrefix}-underlying`}
          type="text"
          autoComplete="off"
          placeholder="AAPL"
          value={value.underlying}
          onChange={(e) => onChange({ ...value, underlying: e.target.value })}
          aria-invalid={errors?.underlying ? true : undefined}
          aria-describedby={errors?.underlying ? `${idPrefix}-underlying-error` : undefined}
        />
        {errors?.underlying && (
          <p id={`${idPrefix}-underlying-error`} className="text-sm text-destructive">
            {errors.underlying}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-expiry`}>Expiry</Label>
        <Input
          id={`${idPrefix}-expiry`}
          type="date"
          min="2000-01-01"
          max="2049-12-31"
          value={value.expiry}
          onChange={(e) => onChange({ ...value, expiry: e.target.value })}
          aria-invalid={errors?.expiry ? true : undefined}
          aria-describedby={errors?.expiry ? `${idPrefix}-expiry-error` : undefined}
        />
        {errors?.expiry && (
          <p id={`${idPrefix}-expiry-error`} className="text-sm text-destructive">
            {errors.expiry}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Type</Label>
        <Tabs
          value={value.type}
          onValueChange={(v) => onChange({ ...value, type: v as 'call' | 'put' })}
        >
          <TabsList>
            <TabsTrigger value="call" className="cursor-pointer">
              Call
            </TabsTrigger>
            <TabsTrigger value="put" className="cursor-pointer">
              Put
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-strike`}>Strike</Label>
        <Input
          id={`${idPrefix}-strike`}
          type="text"
          inputMode="decimal"
          placeholder="150.00"
          value={value.strike}
          onChange={(e) => onChange({ ...value, strike: e.target.value })}
          aria-invalid={errors?.strike ? true : undefined}
          aria-describedby={errors?.strike ? `${idPrefix}-strike-error` : undefined}
        />
        {errors?.strike && (
          <p id={`${idPrefix}-strike-error`} className="text-sm text-destructive">
            {errors.strike}
          </p>
        )}
      </div>
    </div>
  );
}

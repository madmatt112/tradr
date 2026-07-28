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
}

export function OptionContractFields({ value, onChange, errors }: OptionContractFieldsProps) {
  return (
    <div className="space-y-3">
      {errors?.form && (
        <p id="occ-form-error" role="alert" className="text-sm text-destructive">
          {errors.form}
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="occ-underlying">Underlying</Label>
        <Input
          id="occ-underlying"
          type="text"
          autoComplete="off"
          placeholder="AAPL"
          value={value.underlying}
          onChange={(e) => onChange({ ...value, underlying: e.target.value })}
          aria-invalid={errors?.underlying ? true : undefined}
          aria-describedby={errors?.underlying ? 'occ-underlying-error' : undefined}
        />
        {errors?.underlying && (
          <p id="occ-underlying-error" className="text-sm text-destructive">
            {errors.underlying}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="occ-expiry">Expiry</Label>
        <Input
          id="occ-expiry"
          type="date"
          min="2000-01-01"
          max="2049-12-31"
          value={value.expiry}
          onChange={(e) => onChange({ ...value, expiry: e.target.value })}
          aria-invalid={errors?.expiry ? true : undefined}
          aria-describedby={errors?.expiry ? 'occ-expiry-error' : undefined}
        />
        {errors?.expiry && (
          <p id="occ-expiry-error" className="text-sm text-destructive">
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
        <Label htmlFor="occ-strike">Strike</Label>
        <Input
          id="occ-strike"
          type="text"
          inputMode="decimal"
          placeholder="150.00"
          value={value.strike}
          onChange={(e) => onChange({ ...value, strike: e.target.value })}
          aria-invalid={errors?.strike ? true : undefined}
          aria-describedby={errors?.strike ? 'occ-strike-error' : undefined}
        />
        {errors?.strike && (
          <p id="occ-strike-error" className="text-sm text-destructive">
            {errors.strike}
          </p>
        )}
      </div>
    </div>
  );
}

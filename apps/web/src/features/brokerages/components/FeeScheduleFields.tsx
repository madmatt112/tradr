import { type Control, type FieldValues, type Path, useController } from 'react-hook-form';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface FeeFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  disabled?: boolean;
}

function FeeField<T extends FieldValues>({ control, name, label, disabled }: FeeFieldProps<T>) {
  const { field, fieldState } = useController({ control, name });

  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={field.value ?? ''}
        onChange={field.onChange}
        onBlur={field.onBlur}
        ref={field.ref}
      />
      {fieldState.error && <p className="text-sm text-destructive">{fieldState.error.message}</p>}
    </div>
  );
}

interface FeeScheduleFieldsProps<T extends FieldValues> {
  control: Control<T>;
  disabled?: boolean;
}

export function FeeScheduleFields<T extends FieldValues>({
  control,
  disabled,
}: FeeScheduleFieldsProps<T>) {
  return (
    <div className="space-y-6">
      <fieldset className="space-y-3 rounded-md border p-4">
        <legend className="px-2 text-sm font-medium">Stock Fees</legend>
        <FeeField
          control={control}
          name={'feeSchedule.stockPerShareCommission' as Path<T>}
          label="Per Share Commission"
          disabled={disabled}
        />
        <FeeField
          control={control}
          name={'feeSchedule.stockMinPerFill' as Path<T>}
          label="Min Per Fill"
          disabled={disabled}
        />
        <FeeField
          control={control}
          name={'feeSchedule.stockMaxPerFill' as Path<T>}
          label="Max Per Fill"
          disabled={disabled}
        />
      </fieldset>

      <fieldset className="space-y-3 rounded-md border p-4">
        <legend className="px-2 text-sm font-medium">Options Fees</legend>
        <FeeField
          control={control}
          name={'feeSchedule.optionsPerContractCommission' as Path<T>}
          label="Per Contract Commission"
          disabled={disabled}
        />
        <FeeField
          control={control}
          name={'feeSchedule.optionsPerContractExchangeFee' as Path<T>}
          label="Per Contract Exchange Fee"
          disabled={disabled}
        />
        <FeeField
          control={control}
          name={'feeSchedule.optionsMinPerFill' as Path<T>}
          label="Min Per Fill"
          disabled={disabled}
        />
        <FeeField
          control={control}
          name={'feeSchedule.optionsMaxPerFill' as Path<T>}
          label="Max Per Fill"
          disabled={disabled}
        />
      </fieldset>
    </div>
  );
}

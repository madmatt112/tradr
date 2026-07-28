import { z } from 'zod';

// Non-negative finite decimal string validator (reusable).
// Rejects leading/trailing whitespace — Number("  50  ") passes but decimal.js
// throws on padded strings, which would leak an internal error to API clients.
const feeField = z
  .string()
  .refine(
    (v) => {
      if (v !== v.trim()) return false;
      const n = Number(v);
      return !isNaN(n) && isFinite(n) && n >= 0;
    },
    {
      message: 'Must be a non-negative number',
    },
  )
  .default('0');

export const FeeScheduleSchema = z.object({
  stockPerShareCommission: feeField,
  stockMinPerFill: feeField,
  stockMaxPerFill: feeField,
  optionsPerContractCommission: feeField,
  optionsPerContractExchangeFee: feeField,
  optionsMinPerFill: feeField,
  optionsMaxPerFill: feeField,
});

export const CreateBrokerageSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  notes: z.string().max(10000).nullable().optional(),
});

export const UpdateBrokerageSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  notes: z.string().max(10000).nullable().optional(),
  feeSchedule: FeeScheduleSchema.partial().optional(),
});

export const BrokerageSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  name: z.string(),
  notes: z.string().nullable(),
  isSystem: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  feeSchedule: FeeScheduleSchema,
});

export type FeeSchedule = z.infer<typeof FeeScheduleSchema>;
export type CreateBrokerageInput = z.infer<typeof CreateBrokerageSchema>;
export type UpdateBrokerageInput = z.infer<typeof UpdateBrokerageSchema>;
export type Brokerage = z.infer<typeof BrokerageSchema>;

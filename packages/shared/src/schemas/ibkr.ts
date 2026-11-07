import { z } from 'zod';

export const IbkrConnectionSaveSchema = z.object({
  token: z.string().trim().min(8).max(512),
  queryId: z.string().trim().min(1).max(64),
});

export const IbkrConnectionStatusSchema = z.object({
  accountId: z.string().uuid(),
  tokenHintTail: z.string(),
  lastFetchedAt: z.string().nullable(),
  lastPeriodStart: z.string().nullable(),
  lastPeriodEnd: z.string().nullable(),
});

export const FlexFetchRequestSchema = z.object({
  accountId: z.string().uuid(),
});

export type IbkrConnectionSave = z.infer<typeof IbkrConnectionSaveSchema>;
export type IbkrConnectionStatus = z.infer<typeof IbkrConnectionStatusSchema>;
export type FlexFetchRequest = z.infer<typeof FlexFetchRequestSchema>;

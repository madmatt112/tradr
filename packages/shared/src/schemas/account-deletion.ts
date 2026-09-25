import { z } from 'zod';

import { PasswordField } from './auth';

// Wire-side validation contract for the account-deletion feature, per design C1.
// Shape only — consumed by both apps/api (route validation + response shaping)
// and apps/web (hook return types), never redefined per app.

// --- POST /api/users/me/deletion -------------------------------------------

// Reuses PasswordField for the 8-72 bound (schemas/auth.ts) so the delete gate
// accepts exactly the passwords every other auth path does (Req 1.4).
export const AccountDeletionRequestSchema = z.object({
  password: PasswordField,
});
export type AccountDeletionRequest = z.infer<typeof AccountDeletionRequestSchema>;

// Discriminated on `outcome`: an immediate delete carries nothing, a scheduled
// one carries the ISO instant billing resolves and the delete fires.
export const AccountDeletionResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('deleted') }),
  z.object({ outcome: z.literal('scheduled'), scheduledFor: z.string() }),
]);
export type AccountDeletionResult = z.infer<typeof AccountDeletionResultSchema>;

// --- GET /api/users/me/deletion --------------------------------------------

// Both fields null when no schedule row exists.
export const AccountDeletionStatusSchema = z.object({
  scheduledFor: z.string().nullable(),
  state: z.enum(['pending', 'scheduled', 'cancelling', 'firing']).nullable(),
});
export type AccountDeletionStatus = z.infer<typeof AccountDeletionStatusSchema>;

// --- Object-storage purge outcome ------------------------------------------

// Result of purging a deleted user's objects: `not_applicable` when object
// storage is unconfigured, `pending`/`incomplete` mean the gc pass retries.
export const PurgeOutcomeSchema = z.enum(['pending', 'complete', 'incomplete', 'not_applicable']);
export type PurgeOutcome = z.infer<typeof PurgeOutcomeSchema>;

// --- POST /api/admin/users/:id/delete --------------------------------------

// `confirmEmail` is the safety mechanism, checked server-side against the
// target's address (mirrors AdminResetRequestSchema).
export const AdminDeleteUserRequestSchema = z.object({
  confirmEmail: z.string().email(),
});
export type AdminDeleteUserRequest = z.infer<typeof AdminDeleteUserRequestSchema>;

export const AdminDeleteUserResultSchema = z.object({
  userId: z.string().uuid(),
  outcome: z.literal('deleted'),
  purgeOutcome: PurgeOutcomeSchema,
});
export type AdminDeleteUserResult = z.infer<typeof AdminDeleteUserResultSchema>;

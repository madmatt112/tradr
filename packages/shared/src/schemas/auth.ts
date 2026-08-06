import { z } from 'zod';

import { ReportingTimezoneField } from './user';

// Normalized email: transform-BEFORE-validate (trim + lowercase, then .email()),
// so the parsed output matches the stored lowercase form (REQ-3.8) — the corrected
// order the SEED_ADMIN_EMAIL comment in apps/api/src/lib/config.ts documents.
// LoginSchema/RegisterSchema below keep their `.email().trim().toLowerCase()` order:
// reordering would change which raw inputs the frozen endpoints accept (REQ-1.1).
export const EmailField = z.string().trim().toLowerCase().email();

// 32-byte CSPRNG token as lowercase hex — rejects junk before any DB work.
export const TokenField = z.string().regex(/^[0-9a-f]{64}$/);

export const LoginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(8).max(72),
});

export const RegisterSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(8).max(72),
  // Browser-detected reporting timezone (user-onboarding R2.2). OPTIONAL and
  // must stay that way: scripted registrations and the existing e2e helpers
  // post without it, and an absent value falls back to a defined default
  // server-side rather than being stored as null-and-guessed-later (R2.3).
  // Not the account trading-day timezone — see schemas/user.ts.
  timezone: ReportingTimezoneField.optional(),
});

export const PasswordResetRequestSchema = z.object({
  email: EmailField,
});

export const PasswordResetCompleteSchema = z.object({
  token: TokenField,
  password: z.string().min(8).max(72),
});

export const VerifyEmailSchema = z.object({
  token: TokenField,
});

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  isAdmin: z.boolean(),
  emailVerified: z.boolean(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type PasswordResetRequestInput = z.infer<typeof PasswordResetRequestSchema>;
export type PasswordResetCompleteInput = z.infer<typeof PasswordResetCompleteSchema>;
export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;
export type User = z.infer<typeof UserSchema>;

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

// The password length rule, in ONE place. 8 is the minimum the sign-up form has
// always asked for; 72 is bcrypt's byte ceiling, past which the hash silently
// ignores the tail. Every path that accepts a password — login, register, reset
// completion, and the `tradr create-user` / `tradr reset-password` CLI commands —
// reads these, so a password one path accepts is a password the others accept.
// Duplicating the numbers is how the CLI came to create accounts that could not
// log in.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
export const PasswordField = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const LoginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: PasswordField,
});

export const RegisterSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: PasswordField,
  // Browser-detected reporting timezone. OPTIONAL and must stay that way:
  // scripted registrations and the existing e2e helpers post without it, and
  // an absent value falls back to a defined default server-side rather than
  // being stored as null-and-guessed-later. Not the account trading-day
  // timezone — see schemas/user.ts.
  timezone: ReportingTimezoneField.optional(),
});

export const PasswordResetRequestSchema = z.object({
  email: EmailField,
});

export const PasswordResetCompleteSchema = z.object({
  token: TokenField,
  password: PasswordField,
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

// Client hooks for the two-factor management surface (design C8, Req
// 1.2/1.6/1.7/1.8/1.10). One status query keyed `['auth','two-factor']` and the
// four management mutations that back the settings section — enrol, confirm,
// regenerate backup codes, and disable. The server routes are design C5
// (apps/api/src/features/auth/two-factor.route.ts): GET /auth/two-factor,
// POST /auth/two-factor/enrol, /enrol/confirm, /backup-codes and /disable.
//
// Confirm and disable are the only two that change whether two-factor is on, so
// each writes the fresh value straight into the status cache rather than
// invalidating — the server's own answer carries it, and a refetch is a wasted
// round trip.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const twoFactorKeys = {
  status: () => ['auth', 'two-factor'] as const,
};

export interface TwoFactorStatus {
  enabled: boolean;
}

export interface TwoFactorEnrolment {
  /** The base32 TOTP secret, shown as the text key. */
  secret: string;
  /** The otpauth:// provisioning URI, drawn as the QR code. */
  otpauthUri: string;
}

export interface BackupCodes {
  backupCodes: string[];
}

export function useTwoFactor() {
  const queryClient = useQueryClient();

  const status = useQuery<TwoFactorStatus>({
    queryKey: twoFactorKeys.status(),
    queryFn: () => api.get<TwoFactorStatus>('/auth/two-factor'),
  });

  const enrol = useMutation<TwoFactorEnrolment, unknown, void>({
    mutationFn: () => api.post<TwoFactorEnrolment>('/auth/two-factor/enrol'),
  });

  const confirm = useMutation<BackupCodes, unknown, { code: string }>({
    mutationFn: (input) => api.post<BackupCodes>('/auth/two-factor/enrol/confirm', input),
    onSuccess: () => {
      queryClient.setQueryData<TwoFactorStatus>(twoFactorKeys.status(), { enabled: true });
    },
  });

  const regenerate = useMutation<BackupCodes, unknown, { code: string }>({
    mutationFn: (input) => api.post<BackupCodes>('/auth/two-factor/backup-codes', input),
  });

  const disable = useMutation<TwoFactorStatus, unknown, { password: string; code: string }>({
    mutationFn: (input) => api.post<TwoFactorStatus>('/auth/two-factor/disable', input),
    onSuccess: (data) => {
      queryClient.setQueryData<TwoFactorStatus>(twoFactorKeys.status(), { enabled: data.enabled });
    },
  });

  return { status, enrol, confirm, regenerate, disable };
}

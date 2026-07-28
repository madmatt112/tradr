import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';

// SF-2: API errors are discriminated on the envelope's code
// ({ error: { code } }) — never on err.message, never on bare status.
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

/**
 * Shared code-keyed resend-verification handling (design Component 9):
 * mutation to POST /auth/verify-email/resend, outcomes keyed on the
 * envelope code —
 * - 200 → success toast;
 * - EMAIL_NOT_CONFIGURED → informational in-page message (`info`);
 * - ALREADY_VERIFIED → informational message + ['auth','me'] invalidation
 *   so a stale verified state self-cures;
 * - RATE_LIMITED → try-again-later toast.
 *
 * Used by the register check-your-email state and the settings Account page.
 */
export function useResendVerification() {
  const queryClient = useQueryClient();
  const [info, setInfo] = useState('');

  const resend = useMutation({
    mutationFn: () => api.post('/auth/verify-email/resend'),
    onSuccess: () => {
      setInfo('');
      toast.success('Verification email sent.');
    },
    onError: (err: unknown) => {
      const code = errorCode(err);
      if (code === 'EMAIL_NOT_CONFIGURED') {
        setInfo(
          'This instance has no email configured — verification is unavailable and not required.',
        );
      } else if (code === 'ALREADY_VERIFIED') {
        setInfo('Your email is already verified.');
        void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      } else if (code === 'RATE_LIMITED') {
        toast.error('Too many requests — try again later.');
      } else {
        toast.error('Something went wrong. Please try again.');
      }
    },
  });

  return { resend, info };
}

import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  PasswordResetRequestSchema,
  type PasswordResetRequestInput,
} from '@tradr/shared/schemas/auth';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

// SF-3: this page is public and MUST NOT call useAuth() or mount the
// ['auth','me'] query — the api client's global 401 interception would
// redirect a logged-out visitor to /login before the form renders.

// SF-2: API errors are discriminated on the envelope's code
// ({ error: { code } }) — never on err.message, never on bare status.
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

function ForgotPasswordPage() {
  const [state, setState] = useState<'form' | 'sent' | 'unavailable'>('form');
  const [apiError, setApiError] = useState('');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PasswordResetRequestInput>({
    resolver: zodResolver(PasswordResetRequestSchema),
  });

  const onSubmit = async (data: PasswordResetRequestInput) => {
    setApiError('');
    try {
      // The response body is deliberately ignored: the endpoint answers the
      // same way for existing and nonexistent accounts (no-enumeration).
      await api.post('/auth/password-reset/request', data);
      setState('sent');
    } catch (err: unknown) {
      const code = errorCode(err);
      if (code === 'EMAIL_NOT_CONFIGURED') {
        setState('unavailable');
      } else if (code === 'RATE_LIMITED') {
        setApiError('Too many requests — try again later.');
      } else {
        setApiError('Something went wrong. Please try again.');
      }
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Reset your password</CardTitle>
        </CardHeader>
        <CardContent>
          {state === 'sent' && (
            <p className="text-sm text-muted-foreground">
              If an account exists for that address, a reset link is on its way — check your inbox.
            </p>
          )}

          {state === 'unavailable' && (
            <p className="text-sm text-muted-foreground">
              This instance has no email configured. Self-service reset is unavailable — ask your
              operator to reset your password (<code>tradr reset-password</code>).
            </p>
          )}

          {state === 'form' && (
            <>
              {apiError && <p className="mb-4 text-sm text-destructive">{apiError}</p>}

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    aria-describedby={errors.email ? 'email-error' : undefined}
                    {...register('email')}
                  />
                  {errors.email && (
                    <p id="email-error" className="text-sm text-destructive">
                      {errors.email.message}
                    </p>
                  )}
                </div>

                <Button type="submit" className="w-full cursor-pointer" disabled={isSubmitting}>
                  {isSubmitting ? 'Sending...' : 'Send reset link'}
                </Button>
              </form>
            </>
          )}

          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link to="/login" className="underline">
              Back to log in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordPage,
});

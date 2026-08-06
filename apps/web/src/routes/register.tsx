import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { RegisterSchema } from '@tradr/shared';
import type { User } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { useResendVerification } from '@/hooks/useResendVerification';
import { api } from '@/lib/api';
import { detectBrowserTimezone } from '@/lib/browserTimezone';

const RegisterFormSchema = RegisterSchema.extend({
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

type RegisterFormInput = z.infer<typeof RegisterFormSchema>;

function RegisterPage() {
  const { isLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [apiError, setApiError] = useState('');
  // Check-your-email state flag: the registered address, set on a 201 with
  // emailVerified false (D14 — configuredness learned from our own response).
  const [pendingEmail, setPendingEmail] = useState('');
  const { resend, info } = useResendVerification();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormInput>({
    resolver: zodResolver(RegisterFormSchema),
  });

  // SF-4: checked BEFORE the isAuthenticated guard below — registration
  // auto-logs-in, so the default QueryClient's focus refetch flips the
  // me-query to success the moment the user tabs to their mail client and
  // back; without this ordering the guard would destroy the state. The
  // "Continue to dashboard" button is the only exit.
  if (pendingEmail) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Check your email</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              We sent a verification link to{' '}
              <span className="font-medium text-foreground">{pendingEmail}</span>. Follow it to
              verify your email address.
            </p>

            {info && <p className="text-sm text-muted-foreground">{info}</p>}

            <Button
              type="button"
              variant="outline"
              className="w-full cursor-pointer"
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
            >
              {resend.isPending ? 'Sending...' : 'Resend verification email'}
            </Button>

            <Button
              type="button"
              className="w-full cursor-pointer"
              onClick={() => navigate({ to: '/dashboard' })}
            >
              Continue to dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) {
    navigate({ to: '/dashboard' });
    return null;
  }

  const onSubmit = async (data: RegisterFormInput) => {
    setApiError('');
    try {
      const detectedTimezone = detectBrowserTimezone();
      const response = await api.post<{ user: User }>('/auth/register', {
        email: data.email,
        password: data.password,
        // Spread, not `timezone: detectedTimezone ?? null` — see
        // detectBrowserTimezone: the key must be absent, not null.
        ...(detectedTimezone ? { timezone: detectedTimezone } : {}),
      });
      if (response.user.emailVerified) {
        // Email not configured on this instance — today's flow, unchanged.
        navigate({ to: '/dashboard' });
      } else {
        setPendingEmail(response.user.email);
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      setApiError(error?.message || 'An unexpected error occurred');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create an account</CardTitle>
        </CardHeader>
        <CardContent>
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

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                aria-describedby={errors.password ? 'password-error' : undefined}
                {...register('password')}
              />
              {errors.password && (
                <p id="password-error" className="text-sm text-destructive">
                  {errors.password.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                aria-describedby={errors.confirmPassword ? 'confirm-error' : undefined}
                {...register('confirmPassword')}
              />
              {errors.confirmPassword && (
                <p id="confirm-error" className="text-sm text-destructive">
                  {errors.confirmPassword.message}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full cursor-pointer" disabled={isSubmitting}>
              {isSubmitting ? 'Creating account...' : 'Register'}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link to="/login" className="underline">
              Log in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute('/register')({
  component: RegisterPage,
});

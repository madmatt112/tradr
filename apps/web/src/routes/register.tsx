import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { RegisterSchema } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRegister } from '@/hooks/useAuth';
import { useRegistrationEnabled } from '@/hooks/useRegistrationEnabled';
import { useResendVerification } from '@/hooks/useResendVerification';
import { detectBrowserTimezone } from '@/lib/browserTimezone';

// Where someone sent here before launch can leave their address. An <a> and a
// new tab, not a router <Link>: it is a different host, and REQ-9.6 wants this
// page to stay on the app domain rather than bounce the visitor off the one they
// chose to open.
const NEWSLETTER_URL = 'https://www.tradr.cloud/newsletter';

// SF-3: this page is public and MUST NOT call useAuth() or mount the
// ['auth','me'] query — the api client's global 401 interception would redirect
// a logged-out visitor to /login before the form renders. It did: a cold load of
// /register (a bookmark, a refresh, an emailed signup link) 401'd on /auth/me and
// landed on /login?expired=true, so the only way to reach this form was to click
// through from /login and a new user sent a signup link could not sign up.
// routes/__tests__/public-routes-cold-load.test.tsx enforces this.
//
// `useRegister` comes from the same module as `useAuth` and is not it: it is the
// registration mutation alone, with no me-query beside it, exactly as `useLogin`
// is on /login.

const RegisterFormSchema = RegisterSchema.extend({
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

type RegisterFormInput = z.infer<typeof RegisterFormSchema>;

function RegisterPage() {
  const navigate = useNavigate();
  const [apiError, setApiError] = useState('');
  // Check-your-email state flag: the registered address, set on a 201 with
  // emailVerified false (D14 — configuredness learned from our own response).
  const [pendingEmail, setPendingEmail] = useState('');
  const { resend, info } = useResendVerification();
  const registerAccount = useRegister();
  const { registrationEnabled, isPending: configPending } = useRegistrationEnabled();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormInput>({
    resolver: zodResolver(RegisterFormSchema),
  });

  // The gate is decided before anything below renders, and every hook above has
  // already run, so the early returns cannot reorder them.
  //
  // THE PAGE WAITS ONE TICK RATHER THAN GUESSING. Painting the form and swapping
  // it for the notice a moment later shows a closed instance a form it will
  // never accept, which is the exact thing REQ-9.4 is about. The wait is bounded
  // by `retry: false`, and it is usually zero: /login has already read the same
  // ['config'] query for anyone who arrived through it.
  if (configPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!registrationEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Signups open at launch</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              New accounts aren&apos;t open yet. Join the newsletter and we&apos;ll tell you the day
              they are.
            </p>

            <Button asChild className="w-full cursor-pointer">
              <a href={NEWSLETTER_URL} target="_blank" rel="noreferrer">
                Join the newsletter
              </a>
            </Button>

            <p className="text-center text-sm text-muted-foreground">
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

  // SF-4: registration auto-logs-in, so this state has to survive the user
  // tabbing away to their mail client and back. It does, because nothing on this
  // page watches the session: there is no me-query to flip to success on the
  // focus refetch and no authenticated guard to navigate away when it does. The
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

  const onSubmit = async (data: RegisterFormInput) => {
    setApiError('');
    try {
      const detectedTimezone = detectBrowserTimezone();
      // Through `useRegister`, never `api.post` directly: registering swaps the
      // session cookie, so it has to run the same client-state teardown a login
      // does or the new account opens onto the previous user's cache, drawer
      // and walkthrough.
      const response = await registerAccount.mutateAsync({
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

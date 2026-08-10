import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { LoginSchema, type LoginInput } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/hooks/useAuth';

// SF-3: this page is public and MUST NOT call useAuth() or mount the
// ['auth','me'] query — the api client's global 401 interception would answer a
// logged-out visitor's cold load by navigating to /login?expired=true, so the
// page would greet them with a session-expired notice for a session they never
// had. useLogin is the login mutation without that query.

function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const [apiError, setApiError] = useState('');
  const expired = new URLSearchParams(window.location.search).get('expired');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(LoginSchema),
  });

  const onSubmit = async (data: LoginInput) => {
    setApiError('');
    try {
      await login.mutateAsync(data);
      navigate({ to: '/dashboard' });
    } catch (err: unknown) {
      const error = err as { message?: string };
      setApiError(error?.message || 'An unexpected error occurred');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Log in</CardTitle>
        </CardHeader>
        <CardContent>
          {expired === 'true' && (
            <p className="mb-4 text-sm text-destructive">Session expired. Please log in again.</p>
          )}

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
                autoComplete="current-password"
                aria-describedby={errors.password ? 'password-error' : undefined}
                {...register('password')}
              />
              {errors.password && (
                <p id="password-error" className="text-sm text-destructive">
                  {errors.password.message}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full cursor-pointer" disabled={isSubmitting}>
              {isSubmitting ? 'Logging in...' : 'Log in'}
            </Button>
          </form>

          {/* Always rendered (REQ-8.3, D14): on an email-less instance the
              linked page shows the defined-unavailability state. */}
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link to="/forgot-password" className="underline">
              Forgot password?
            </Link>
          </p>

          <p className="mt-2 text-center text-sm text-muted-foreground">
            Don't have an account?{' '}
            <Link to="/register" className="underline">
              Register
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

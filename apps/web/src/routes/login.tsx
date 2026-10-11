import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useForm } from 'react-hook-form';

import { LoginSchema, type LoginInput } from '@tradr/shared';

import { AuthScreen } from '@/components/layout/AuthScreen';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin, useLoginTwoFactor } from '@/hooks/useAuth';
import { useRegistrationEnabled } from '@/hooks/useRegistrationEnabled';

// SF-3: this page is public and MUST NOT call useAuth() or mount the
// ['auth','me'] query — the api client's global 401 interception would answer a
// logged-out visitor's cold load by navigating to /login?expired=true, so the
// page would greet them with a session-expired notice for a session they never
// had. useLogin is the login mutation without that query.

// SF-2: errors are discriminated on the envelope's code and shown from its
// message ({ error: { code, message } }, lib/api), never on err.message or a
// bare status. The server message is what carries the lockout retry hint
// (Req 3.4) and the second-step code errors (design C8).
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

function errorMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { message?: string } }).error?.message;
}

function LoginPage() {
  const login = useLogin();
  const loginTwoFactor = useLoginTwoFactor();
  const navigate = useNavigate();
  const { registrationEnabled } = useRegistrationEnabled();
  const [apiError, setApiError] = useState('');
  // Design C8: once a correct password answers with a challenge, the password
  // form is REPLACED by the code field. Only the code step begins the session.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const expired = new URLSearchParams(window.location.search).get('expired');
  const deleted = new URLSearchParams(window.location.search).get('deleted');

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
      const answer = await login.mutateAsync(data);
      // A two-factor account's correct password starts no session (Req 2.7) —
      // keep the challenge and show the code step instead of navigating.
      if ('twoFactorRequired' in answer) {
        setChallenge(answer.challenge);
        return;
      }
      navigate({ to: '/dashboard' });
    } catch (err: unknown) {
      setApiError(errorMessage(err) || 'An unexpected error occurred');
    }
  };

  const onSubmitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setApiError('');
    try {
      await loginTwoFactor.mutateAsync({ challenge, code });
      navigate({ to: '/dashboard' });
    } catch (err: unknown) {
      // A dead challenge sends the user back to the password step; its message
      // explains why (design C8). Other code errors stay on the code field.
      if (errorCode(err) === 'CHALLENGE_EXPIRED') {
        setChallenge(null);
        setCode('');
      }
      setApiError(errorMessage(err) || 'An unexpected error occurred');
    }
  };

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Log in</CardTitle>
        </CardHeader>
        <CardContent>
          {expired === 'true' && (
            <p className="mb-4 text-sm text-destructive">Session expired. Please log in again.</p>
          )}

          {/* Deletion is not an error — muted, never text-destructive. The
              account-deletion hook navigates here after a `deleted` outcome. */}
          {deleted === 'true' && (
            <p className="mb-4 text-sm text-muted-foreground">Your account was deleted.</p>
          )}

          {apiError && <p className="mb-4 text-sm text-destructive">{apiError}</p>}

          {challenge ? (
            <form onSubmit={onSubmitCode} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="code">Authentication code</Label>
                <Input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
                <p className="text-sm text-muted-foreground">
                  Enter the code from your authenticator app. A backup code also works.
                </p>
              </div>

              <Button
                type="submit"
                className="w-full cursor-pointer"
                disabled={loginTwoFactor.isPending}
              >
                {loginTwoFactor.isPending ? 'Verifying...' : 'Verify'}
              </Button>
            </form>
          ) : (
            <>
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

              {/* Hidden when this instance has registration closed (newsletter
                  REQ-9.4), so /register's launch notice is a backstop for a
                  typed or bookmarked URL rather than the normal way in. The hook
                  fails open, so an unconfigured self-hoster still sees this and
                  so does a visitor whose /api/config read failed. It is not the
                  control — the server refuses the POST either way. */}
              {registrationEnabled && (
                <p className="mt-2 text-center text-sm text-muted-foreground">
                  Don't have an account?{' '}
                  <Link to="/register" className="underline">
                    Register
                  </Link>
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </AuthScreen>
  );
}

interface LoginSearch {
  expired?: boolean;
  deleted?: boolean;
}

export const Route = createFileRoute('/login')({
  // Both notices are still read from the raw query in the component above; this
  // only ROUND-TRIPS the two flags through the typed search. A typed navigate
  // here — the account-deletion hook's `deleted`, lib/api's `expired` — must
  // find its key declared, and validateSearch must return it so it is not
  // stripped from the URL the component then reads.
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    expired: search.expired === true || search.expired === 'true' ? true : undefined,
    deleted: search.deleted === true || search.deleted === 'true' ? true : undefined,
  }),
  component: LoginPage,
});

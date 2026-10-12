import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';

import { AuthScreen } from '@/components/layout/AuthScreen';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

// SF-3: this page is public and MUST NOT call useAuth() or mount the
// ['auth','me'] query — the api client's global 401 interception would
// redirect a logged-out visitor to /login, destroying the #token fragment
// before the page renders.

// SF-2: API errors are discriminated on the envelope's code
// ({ error: { code } }) — never on err.message, never on bare status.
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

// C6: the emailed link carries the token in the URL fragment
// (`/unlock-account#token=<hex>`) so it never leaves the browser.
function readTokenFromHash(): string {
  const hash = window.location.hash;
  return hash.startsWith('#token=') ? hash.slice('#token='.length) : '';
}

function UnlockAccountPage() {
  const [token] = useState(readTokenFromHash);
  const [state, setState] = useState<'idle' | 'success' | 'expired'>('idle');
  const [apiError, setApiError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // REQ-4.9: the lock is cleared only by this explicit user gesture — fetching
  // the emailed URL alone (prefetchers, link scanners) consumes nothing.
  const onUnlock = async () => {
    setApiError('');
    setIsSubmitting(true);
    try {
      // The token travels in the POST body, never a query string.
      await api.post('/auth/unlock', { token });
      setState('success');
    } catch (err: unknown) {
      const code = errorCode(err);
      if (code === 'INVALID_OR_EXPIRED_TOKEN') {
        setState('expired');
      } else if (code === 'RATE_LIMITED') {
        setApiError('Too many requests — try again later.');
      } else {
        setApiError('Something went wrong. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Unlock your account</CardTitle>
        </CardHeader>
        <CardContent>
          {!token && (
            <p className="text-sm text-muted-foreground">
              This link is missing its unlock token. Open the link from your email again.
            </p>
          )}

          {token && state === 'success' && (
            <>
              <p className="text-sm text-muted-foreground">Your account is unlocked.</p>
              <p className="mt-4 text-center text-sm text-muted-foreground">
                <Link to="/login" className="underline">
                  Log in
                </Link>
              </p>
            </>
          )}

          {token && state === 'expired' && (
            <p className="text-sm text-muted-foreground">This link is invalid or has expired.</p>
          )}

          {token && state === 'idle' && (
            <>
              {apiError && <p className="mb-4 text-sm text-destructive">{apiError}</p>}

              <Button
                type="button"
                className="w-full cursor-pointer"
                disabled={isSubmitting}
                onClick={onUnlock}
              >
                {isSubmitting ? 'Unlocking...' : 'Unlock account'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </AuthScreen>
  );
}

export const Route = createFileRoute('/unlock-account')({
  component: UnlockAccountPage,
});

import { createFileRoute } from '@tanstack/react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useResendVerification } from '@/hooks/useResendVerification';

function SettingsAccount() {
  const { user, logout } = useAuth();
  // Shared code-keyed resend handling (design Component 9, SF-2/MN-4):
  // 200 → toast; EMAIL_NOT_CONFIGURED / ALREADY_VERIFIED → `info` (the
  // latter also invalidates ['auth','me'] so a stale badge self-cures);
  // RATE_LIMITED → try-again-later toast.
  const { resend, info } = useResendVerification();

  return (
    <div className="space-y-6" data-slot="settings-account">
      <div>
        <h2 className="text-lg font-medium">Account</h2>
        <p className="text-sm text-muted-foreground">Manage your account and session.</p>
      </div>

      {user && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm">{user.email}</span>
            {/* REQ-5.1: unverified is informational, never a problem state —
                neutral tokens only (no destructive). */}
            {user.emailVerified ? (
              <Badge variant="secondary">Verified</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Not verified
              </Badge>
            )}
          </div>

          {/* Rendered outside the unverified branch so the ALREADY_VERIFIED
              message survives the badge self-curing to "Verified". */}
          {info && <p className="text-sm text-muted-foreground">{info}</p>}

          {!user.emailVerified && (
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
            >
              {resend.isPending ? 'Sending...' : 'Resend verification email'}
            </Button>
          )}
        </div>
      )}

      <Button
        variant="outline"
        className="cursor-pointer"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        Log out
      </Button>
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/account')({
  component: SettingsAccount,
});

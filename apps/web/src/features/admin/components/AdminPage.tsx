// AdminPage — top-level admin route page (design §Component 11; REQ-7.1/7.3).
//
// Renders three sections: Stats, Users (UserTable), Usage (UsageSection).
//
// The not-authorized state here is CONVENIENCE ONLY — the backend 403 from
// adminMiddleware is the real boundary. It renders when useAuth() reports
// `user.isAdmin === false` OR any admin query fails with the ADMIN_REQUIRED
// code. The api client throws the raw error envelope with `status` patched on
// (api.ts), so the code lives at `err.error?.code` — never `err.code` on this
// path (that shape exists only on the bespoke SSE stream).

import { Link } from '@tanstack/react-router';
import { ShieldOff } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { useAuth } from '@/hooks/useAuth';

import { useAdminStats } from '../hooks/useAdminStats';

import { StatsCards } from './StatsCards';
import { UsageSection } from './UsageSection';
import { UserTable } from './UserTable';

function isAdminRequiredError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { error?: { code?: string } };
  return e.error?.code === 'ADMIN_REQUIRED';
}

export function AdminPage() {
  const { user } = useAuth();
  const statsQuery = useAdminStats();

  const notAuthorized = user?.isAdmin === false || isAdminRequiredError(statsQuery.error);

  if (notAuthorized) {
    return (
      <EmptyState
        title="Not authorized"
        description="This page requires admin access."
        icon={<ShieldOff className="h-8 w-8" aria-hidden="true" />}
        action={
          <Link
            to="/dashboard"
            className="cursor-pointer text-sm font-medium underline underline-offset-4 hover:text-foreground"
          >
            Back to dashboard
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="admin-stats-heading">
        <h2 id="admin-stats-heading" className="mb-4 text-lg font-semibold">
          Stats
        </h2>
        {statsQuery.isError ? (
          <p className="text-sm text-muted-foreground">Failed to load stats.</p>
        ) : (
          <StatsCards stats={statsQuery.data} isLoading={statsQuery.isLoading} />
        )}
      </section>

      <section aria-labelledby="admin-users-heading">
        <h2 id="admin-users-heading" className="mb-4 text-lg font-semibold">
          Users
        </h2>
        <UserTable />
      </section>

      <section aria-labelledby="admin-usage-heading">
        <h2 id="admin-usage-heading" className="mb-4 text-lg font-semibold">
          Usage
        </h2>
        <UsageSection />
      </section>
    </div>
  );
}

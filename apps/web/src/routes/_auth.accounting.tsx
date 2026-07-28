import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth/accounting')({
  beforeLoad: ({ location }) => {
    // `/accounting` itself has no content — redirect to the default tab. This
    // route is the PARENT of `/accounting/{expenses,fee-rollup,tax-summary}`, so
    // its `beforeLoad` runs for those children too; without the pathname guard
    // the redirect fires on every child navigation and loops infinitely
    // (mirrors the guard in `_auth.settings.tsx`).
    if (location.pathname === '/accounting' || location.pathname === '/accounting/') {
      throw redirect({ to: '/accounting/expenses' });
    }
  },
});

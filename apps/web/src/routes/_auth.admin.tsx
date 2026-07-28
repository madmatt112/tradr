// Top-level auth-gated admin route (flat dot-notation, like _auth.performance) —
// deliberately NOT a settings tab; SETTINGS_TABS is untouched (REQ-7.1).
import { createFileRoute } from '@tanstack/react-router';

import { AdminPage } from '@/features/admin/components/AdminPage';

export const Route = createFileRoute('/_auth/admin')({
  component: AdminPage,
});

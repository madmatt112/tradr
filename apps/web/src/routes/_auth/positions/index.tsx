import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { PositionList } from '@/features/positions/components/PositionList';

// Deep-link-safe list search: `status` uses the enum-with-catch form of
// `_auth.performance.tsx:28` so a garbage status degrades to "all" instead of
// reaching the API as a 400 (design decision 5); `tag` is the scalar passthrough
// REQ-3.3 pins — the sort happens in `buildListFilters`, never here.
export const PositionsSearchSchema = z.object({
  status: z.enum(['draft', 'open', 'closed']).optional().catch(undefined),
  tag: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_auth/positions/')({
  validateSearch: PositionsSearchSchema,
  component: PositionList,
});

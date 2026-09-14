import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { ClassificationSchema } from '@tradr/shared';

import { PositionList } from '@/features/positions/components/PositionList';

// Deep-link-safe list search: `status` uses the enum-with-catch form of
// `_auth.performance.tsx:28` so a garbage status degrades to "all" instead of
// reaching the API as a 400 (design decision 5); `tag` is the scalar passthrough
// REQ-3.3 pins — the sort happens in `buildListFilters`, never here.
// `classification` (winning/losing/breakeven) takes the same enum-with-catch
// shape so a garbage result filter degrades to "all" too (REQ-9.5/9.6).
export const PositionsSearchSchema = z.object({
  status: z.enum(['draft', 'open', 'closed']).optional().catch(undefined),
  tag: z.string().optional().catch(undefined),
  classification: ClassificationSchema.optional().catch(undefined),
});

export const Route = createFileRoute('/_auth/positions/')({
  validateSearch: PositionsSearchSchema,
  component: PositionList,
});

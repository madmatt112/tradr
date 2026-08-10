import { CoachMark } from '@/features/onboarding/components/CoachMark';

import { BlackScholesCard } from './BlackScholesCard';
import { OccCard } from './OccCard';
import { OptionsChainViewer } from './OptionsChainViewer';

export function OptionsPage() {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">Options Tools</h1>
          {/* No `available` gate, because there is no predicate to
              consult: the Black-Scholes and OCC cards are pure client-side
              computation and are present in every deployment. The chain viewer
              IS gated (on the market-data key, which it reports as
              `configured: false` and handles itself), which is why the copy
              names only the two cards that are always there. */}
          <CoachMark surface="options-tools" />
        </div>
        <p className="text-sm text-muted-foreground">
          Price options with Black-Scholes, look up OCC option symbols, and view live chains.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <BlackScholesCard density="comfortable" />
        <OccCard />
      </div>

      {/* Additive third card (REQ-12.1) — does not restructure the grid above. */}
      <OptionsChainViewer />
    </div>
  );
}

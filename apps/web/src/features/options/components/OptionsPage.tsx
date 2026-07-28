import { BlackScholesCard } from './BlackScholesCard';
import { OccCard } from './OccCard';
import { OptionsChainViewer } from './OptionsChainViewer';

export function OptionsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Options Tools</h1>
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

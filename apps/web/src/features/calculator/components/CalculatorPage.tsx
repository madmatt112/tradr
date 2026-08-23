import { PageHeader } from '@/components/layout/PageHeader';

import { CalculatorForm } from './CalculatorForm';

export function CalculatorPage() {
  return (
    <div className="space-y-6">
      <div>
        <PageHeader page="Trade Calculator" className="mb-2" />
        <p className="text-sm text-muted-foreground">
          Plan position size and risk/reward before placing a trade.
        </p>
      </div>

      <CalculatorForm />
    </div>
  );
}

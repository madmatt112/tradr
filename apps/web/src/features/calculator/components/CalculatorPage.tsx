import { CalculatorForm } from './CalculatorForm';

export function CalculatorPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Trade Calculator</h1>
        <p className="text-sm text-muted-foreground">
          Plan position size and risk/reward before placing a trade.
        </p>
      </div>

      <CalculatorForm />
    </div>
  );
}

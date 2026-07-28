import { CalculatorForm } from '@/features/calculator/components/CalculatorForm';

/**
 * PositionSizingWidget — dashboard widget rendering the position-sizing
 * calculator (Req 6.5). Delegates entirely to `<CalculatorForm />`; no
 * dashboard state is passed in and `calculateTrade` is not re-implemented.
 */
function PositionSizingWidget() {
  return <CalculatorForm />;
}

export default PositionSizingWidget;

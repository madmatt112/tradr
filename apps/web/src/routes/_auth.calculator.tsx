import { createFileRoute } from '@tanstack/react-router';

import { CalculatorPage } from '@/features/calculator/components/CalculatorPage';

export const Route = createFileRoute('/_auth/calculator')({
  component: CalculatorPage,
});

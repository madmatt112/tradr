import { BlackScholesCard } from '@/features/options/components/BlackScholesCard';

export function OptionsPricingTab() {
  return (
    <div className="flex flex-col gap-2 p-2">
      <BlackScholesCard density="compact" />
      <p className="text-muted-foreground text-xs px-2">Inputs reset when you leave this tab.</p>
    </div>
  );
}

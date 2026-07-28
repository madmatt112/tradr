import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface EquityCurveChartSkeletonProps {
  className?: string;
}

/**
 * Loading placeholder for `EquityCurveChart`. Matches the chart's outer
 * container dimensions so the surrounding layout doesn't shift when the
 * lazy chunk resolves.
 *
 * The chart renders inside a `ResponsiveContainer` set to width 100% and
 * a fixed height of 320px (see `EquityCurveChart`). This skeleton mirrors
 * that height exactly so there is no layout jank on swap.
 */
export function EquityCurveChartSkeleton({ className }: EquityCurveChartSkeletonProps) {
  return (
    <Skeleton
      data-testid="equity-curve-chart-skeleton"
      className={cn('h-[320px] w-full', className)}
    />
  );
}

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The reason a row has no market value (design C9, D13; Req 4.7). The
 * `tooltip` variant (widget) puts the reason on a focusable span readable on
 * hover/focus; the `inline` variant (drawer, detail page) shows the reason as
 * plain visible text, because drawer rows are links and a focusable trigger
 * inside a link would nest interactive elements.
 */
export function CostBasisOnly({
  reason,
  variant,
}: {
  reason: string;
  variant: 'tooltip' | 'inline';
}) {
  if (variant === 'inline') {
    return (
      <span>
        <span>Cost basis only</span> <span className="text-muted-foreground">{reason}</span>
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>
          Cost basis only
          <span className="sr-only"> {reason}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

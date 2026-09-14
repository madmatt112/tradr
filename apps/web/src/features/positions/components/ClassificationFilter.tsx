import { useNavigate } from '@tanstack/react-router';

import { CLASSIFICATIONS } from '@tradr/shared';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Classification = (typeof CLASSIFICATIONS)[number];

const RESULT_LABELS: Record<Classification, string> = {
  winning: 'Winning',
  losing: 'Losing',
  breakeven: 'Breakeven',
};

// "All" plus one entry per classification, in the enum's order.
const RESULT_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  ...CLASSIFICATIONS.map((c) => ({ value: c, label: RESULT_LABELS[c] })),
];

interface Props {
  /** The active classification, or 'all' when the result filter is unset. */
  value: string;
}

/**
 * The result (winning/losing/breakeven) filter for the positions list. It writes
 * only `classification` into the URL — status and tag ride through untouched via
 * `...prev`, so it composes with the status tabs and the tag filter (REQ-9.5).
 */
export function ClassificationFilter({ value }: Props) {
  const navigate = useNavigate();
  return (
    <Select
      value={value}
      onValueChange={(next) =>
        navigate({
          to: '/positions',
          search: (prev) => ({
            ...prev,
            classification: next === 'all' ? undefined : (next as Classification),
          }),
        })
      }
    >
      <SelectTrigger className="cursor-pointer" aria-label="Result">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RESULT_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="cursor-pointer">
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

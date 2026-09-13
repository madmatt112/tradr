import { XIcon } from 'lucide-react';

import { TAG_CATEGORY_PREFIX, type Tag, type TagColor } from '@tradr/shared';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// Static per-colour classes. Tailwind cannot build class names dynamically, so
// each token maps to a literal string it can see at build time. Decorative tint
// only (border + /10 fill); the category letter carries the meaning.
export const TAG_COLOR_CLASSES: Record<TagColor, string> = {
  'tag-1': 'border-tag-1/40 bg-tag-1/10 text-foreground',
  'tag-2': 'border-tag-2/40 bg-tag-2/10 text-foreground',
  'tag-3': 'border-tag-3/40 bg-tag-3/10 text-foreground',
  'tag-4': 'border-tag-4/40 bg-tag-4/10 text-foreground',
  'tag-5': 'border-tag-5/40 bg-tag-5/10 text-foreground',
  'tag-6': 'border-tag-6/40 bg-tag-6/10 text-foreground',
};

// The status chip's register (PositionStatusChip.tsx:12), shared by every chip.
const CHIP_CLASS =
  'inline-flex items-center gap-1 rounded-full border px-2 py-px font-mono text-xs tracking-[0.06em]';

const NEUTRAL_CHIP_CLASS = 'border-hairline text-muted-foreground';

const REMOVE_BUTTON_CLASS =
  'cursor-pointer rounded-full text-muted-foreground transition-colors hover:text-foreground';

/** A single tag as a mono pill. Colour is a decorative tint; the category
 * letter and the accessible name (`category: name`, REQ-4.5) carry meaning. */
export function TagChip({
  tag,
  onRemove,
  className,
}: {
  tag: Tag;
  onRemove?: () => void;
  className?: string;
}) {
  const label = `${tag.category}: ${tag.name}`;
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        CHIP_CLASS,
        tag.color === null ? NEUTRAL_CHIP_CLASS : TAG_COLOR_CLASSES[tag.color],
        className,
      )}
    >
      <span className="font-semibold text-muted-foreground">
        {TAG_CATEGORY_PREFIX[tag.category]}
      </span>
      {tag.name}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${tag.name} from filter`}
          onClick={onRemove}
          className={REMOVE_BUTTON_CLASS}
        >
          <XIcon className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}

/** A selected filter id whose tag no longer resolves (deleted in another tab).
 * Neutral, still removable, so a stale filter can be cleared (REQ-3.5). */
export function UnknownTagChip({ id, onRemove }: { id: string; onRemove: (id: string) => void }) {
  return (
    <span
      aria-label="unknown: Unknown tag"
      title="unknown: Unknown tag"
      className={cn(CHIP_CLASS, NEUTRAL_CHIP_CLASS)}
    >
      Unknown tag
      <button
        type="button"
        aria-label="Remove unknown tag from filter"
        onClick={() => onRemove(id)}
        className={REMOVE_BUTTON_CLASS}
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </span>
  );
}

/** A row of chips in the server's order. Past `max`, the overflow collapses to
 * a focusable `+N` marker whose tooltip and accessible name list the rest, so
 * every tag stays reachable by mouse and keyboard (REQ-3.1). Empty → nothing. */
export function TagChipList({
  tags,
  max = Infinity,
  className,
}: {
  tags: Tag[];
  max?: number;
  className?: string;
}) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const rest = tags.slice(max);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {shown.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              role="button"
              aria-label={rest.map((tag) => `${tag.category}: ${tag.name}`).join(', ')}
              className={cn(CHIP_CLASS, NEUTRAL_CHIP_CLASS, 'cursor-pointer')}
            >
              +{rest.length}
            </span>
          </TooltipTrigger>
          <TooltipContent>{rest.map((tag) => tag.name).join(', ')}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

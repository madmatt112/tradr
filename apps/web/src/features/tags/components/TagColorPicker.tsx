import * as React from 'react';

import { TAG_COLORS, type TagColor } from '@tradr/shared';

import { cn } from '@/lib/utils';

// The seven options: the six swatches then "No colour" (null).
const OPTIONS: readonly (TagColor | null)[] = [...TAG_COLORS, null];

// Static solid-fill class per swatch (Tailwind cannot build class names
// dynamically). Decorative — the picker's accessible names carry the meaning.
const SWATCH_BG: Record<TagColor, string> = {
  'tag-1': 'bg-tag-1',
  'tag-2': 'bg-tag-2',
  'tag-3': 'bg-tag-3',
  'tag-4': 'bg-tag-4',
  'tag-5': 'bg-tag-5',
  'tag-6': 'bg-tag-6',
};

/** A radiogroup of six colour swatches plus "No colour" (design Component 11).
 * Roving tabindex: only the checked swatch is tabbable; the arrow keys move the
 * selection and focus together. */
export function TagColorPicker({
  value,
  onChange,
}: {
  value: TagColor | null;
  onChange: (value: TagColor | null) => void;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  function moveTo(index: number) {
    const next = (index + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next]);
    refs.current[next]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveTo(index + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveTo(index - 1);
    }
  }

  return (
    <div role="radiogroup" aria-label="Colour" className="flex items-center gap-2">
      {OPTIONS.map((option, index) => {
        const checked = value === option;
        const isNoColour = option === null;
        return (
          <button
            key={option ?? 'none'}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={isNoColour ? 'No colour' : `Colour ${index + 1}`}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'size-5 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus',
              isNoColour ? 'border border-hairline' : SWATCH_BG[option],
              checked && 'ring-2 ring-focus',
            )}
          />
        );
      })}
    </div>
  );
}

import type { PositionImage } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { isApiCrossOrigin } from '@/lib/api';

import { positionImageUrl } from '../hooks/usePositionImages';

interface PositionImageLightboxProps {
  images: PositionImage[];
  positionId: string;
  symbol: string;
  // The image currently shown, or `null` when the lightbox is closed. The parent
  // owns this state so the thumbnail grid and the lightbox agree on which image
  // is open.
  index: number | null;
  onIndexChange: (index: number | null) => void;
}

// Step one image in `direction` (+1 next / -1 previous) from `from`, wrapping at
// the ends and skipping `unavailable` records (REQ-4.5). Returns `from` when no
// other viewable image exists, so a single image (or an all-unavailable rest)
// is a safe no-op rather than a loop.
function step(images: PositionImage[], from: number, direction: 1 | -1): number {
  const count = images.length;
  if (count === 0) return from;
  let next = from;
  for (let i = 0; i < count; i += 1) {
    next = (next + direction + count) % count;
    if (!images[next]?.unavailable) return next;
  }
  return from;
}

// Full-size viewer for one position screenshot, built on the Radix Dialog
// primitive with no lightbox library (design D25 / requirements D8). Escape
// closes through Radix's own dismiss behaviour; the arrow keys and the
// Previous / Next buttons move between the position's viewable images.
export function PositionImageLightbox({
  images,
  positionId,
  symbol,
  index,
  onIndexChange,
}: PositionImageLightboxProps) {
  const open = index !== null;
  const current = open ? images[index] : undefined;
  const total = images.length;
  const position = index === null ? 0 : index + 1;

  function move(direction: 1 | -1) {
    if (index === null) return;
    onIndexChange(step(images, index, direction));
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onIndexChange(null);
      }}
    >
      <DialogContent onKeyDown={handleKeyDown} className="max-w-[95vw] p-2 sm:max-w-[95vw]">
        <DialogTitle className="sr-only">{`Screenshot ${position} of ${total}`}</DialogTitle>
        {current ? (
          current.unavailable ? (
            <div
              role="img"
              aria-label="Image no longer available"
              data-testid="image-unavailable"
              className="mx-auto flex h-48 w-64 items-center justify-center rounded-md border border-dashed border-border bg-muted text-xs text-muted-foreground"
            >
              Image no longer available
            </div>
          ) : (
            <img
              src={positionImageUrl(positionId, current.id)}
              alt={`Screenshot ${position} of ${symbol}`}
              className="mx-auto max-h-[85vh] w-auto object-contain"
              {...(isApiCrossOrigin() ? { crossOrigin: 'use-credentials' as const } : {})}
            />
          )
        ) : null}
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={() => move(-1)}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={() => move(1)}
          >
            Next
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

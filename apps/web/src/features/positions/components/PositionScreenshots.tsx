import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { POSITION_IMAGE_MAX_BYTES, POSITION_IMAGE_MAX_COUNT } from '@tradr/shared';
import type { PositionImage } from '@tradr/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isApiCrossOrigin } from '@/lib/api';
import { ACCEPTED_IMAGE_FORMATS, fileToBase64, imageFilesFromClipboard } from '@/lib/image-file';

import {
  positionImageUrl,
  useDeletePositionImage,
  useUploadPositionImage,
} from '../hooks/usePositionImages';

import { PositionImageLightbox } from './PositionImageLightbox';

interface Props {
  positionId: string;
  symbol: string;
  images: PositionImage[];
}

// The Screenshots section of the position detail page (design Component 12).
// Rendered on every status between the Notes card and the Fills block. Uploads
// come from the "Add screenshot" picker or a document-level paste; each image is
// read to base64 and posted one at a time in pick order. Thumbnails open the
// lightbox; each carries a delete confirmation.
export function PositionScreenshots({ positionId, symbol, images }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadPositionImage(positionId);
  const deleteImage = useDeletePositionImage(positionId);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const atCap = images.length >= POSITION_IMAGE_MAX_COUNT;

  // Read, cap-check and upload each accepted image in pick order. A `for` loop,
  // never Promise.all, so the server sees creation order (design Component 12);
  // each upload is in try/catch so one failure does not stop the next
  // (REQ-1.5). An oversized file is dropped before any request and the too-large
  // toast fires once per call even if several files are over the cap.
  const addFiles = async (files: File[]) => {
    let oversized = false;
    for (const file of files) {
      const format = ACCEPTED_IMAGE_FORMATS[file.type];
      if (!format) continue;
      const dataBase64 = await fileToBase64(file);
      if (dataBase64.length > POSITION_IMAGE_MAX_BYTES) {
        oversized = true;
        continue;
      }
      try {
        await upload.mutateAsync({ format, dataBase64 });
      } catch {
        // The upload hook surfaces the error toast; swallow here so the next
        // file still uploads.
      }
    }
    if (oversized) {
      toast.error('That image is too large to upload.');
    }
  };

  // Keep the paste handler pointed at the latest addFiles without re-registering
  // the document listener on every render.
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  // Paste anywhere on the page adds screenshots, except while typing in an
  // input, textarea or contentEditable element (design D14).
  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const files = imageFilesFromClipboard(event);
      if (files.length === 0) return;
      event.preventDefault();
      void addFilesRef.current(files);
    }
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    void addFiles(files);
    // Reset so re-picking the same file fires change again.
    event.target.value = '';
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Screenshots</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="outline"
                className="cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
                disabled={atCap}
              >
                Add screenshot
              </Button>
            </span>
          </TooltipTrigger>
          {atCap && (
            <TooltipContent>
              This position holds the maximum of {POSITION_IMAGE_MAX_COUNT} screenshots
            </TooltipContent>
          )}
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={onPickFiles}
        />
      </div>

      {images.length === 0 ? (
        <p className="text-sm text-muted-foreground">No screenshots yet</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {images.map((image, index) => (
            <div key={image.id} className="relative">
              <button
                type="button"
                aria-label={`Open screenshot ${index + 1}`}
                className="block w-full cursor-pointer overflow-hidden rounded-md border border-border"
                onClick={() => setLightboxIndex(index)}
              >
                {image.unavailable ? (
                  <div
                    role="img"
                    aria-label="Image no longer available"
                    data-testid="image-unavailable"
                    className="flex h-32 w-full items-center justify-center bg-muted text-xs text-muted-foreground"
                  >
                    Image no longer available
                  </div>
                ) : (
                  <img
                    src={positionImageUrl(positionId, image.id)}
                    alt={`Screenshot ${index + 1} of ${symbol}`}
                    loading="lazy"
                    className="h-32 w-full object-cover"
                    {...(isApiCrossOrigin() ? { crossOrigin: 'use-credentials' as const } : {})}
                  />
                )}
              </button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                aria-label={`Delete screenshot ${index + 1}`}
                className="absolute top-1 right-1 cursor-pointer"
                onClick={() => setDeleteId(image.id)}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}

      <PositionImageLightbox
        images={images}
        positionId={positionId}
        symbol={symbol}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
      />

      <AlertDialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete screenshot</AlertDialogTitle>
            <AlertDialogDescription>
              This screenshot will be permanently removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={() => {
                if (deleteId) deleteImage.mutate(deleteId);
                setDeleteId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

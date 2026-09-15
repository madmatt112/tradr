import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { PositionDetail, PositionImage, UploadPositionImage } from '@tradr/shared';

import { api, resolveApiUrl } from '@/lib/api';

import { handlePositionMutationError } from './usePosition';

// Absolute URL for one screenshot's bytes. The thumbnail grid and the lightbox
// both use it for `img src`; the route serves the object (or inline) bytes with
// the session cookie. Split-origin callers add `crossOrigin="use-credentials"`
// themselves (isApiCrossOrigin).
export function positionImageUrl(positionId: string, imageId: string): string {
  return resolveApiUrl(`/positions/${positionId}/images/${imageId}`);
}

// Upload one screenshot. On success it appends the created record to this
// position's detail cache so the grid shows it without a reload, then
// invalidates ['positions'] so a reload agrees. A 401 short-circuits through the
// shared handler before any invalidation or toast.
export function useUploadPositionImage(positionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadPositionImage) =>
      api.post<PositionImage>(`/positions/${positionId}/images`, input),
    onSuccess: (created) => {
      queryClient.setQueryData<PositionDetail>(
        ['positions', 'detail', positionId],
        (prev) => prev && { ...prev, images: [...(prev.images ?? []), created] },
      );
      queryClient.invalidateQueries({ queryKey: ['positions'] });
    },
    onError: (err: unknown) => {
      handlePositionMutationError(err, queryClient, 'Upload failed', toast.error);
    },
  });
}

// Delete one screenshot. On success it invalidates ['positions'] (list + this
// detail) and toasts; a 401 short-circuits through the shared handler.
export function useDeletePositionImage(positionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (imageId: string) => api.delete(`/positions/${positionId}/images/${imageId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      toast.success('Screenshot deleted');
    },
    onError: (err: unknown) => {
      handlePositionMutationError(err, queryClient, 'Upload failed', toast.error);
    },
  });
}

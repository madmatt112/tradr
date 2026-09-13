import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  CreateTagInput,
  PositionDetail,
  StarterAnswer,
  StarterAnswerResult,
  Tag,
  TagWithCount,
  UpdateTagInput,
} from '@tradr/shared';

import { ONBOARDING_QUERY_KEY } from '@/features/onboarding/hooks/useOnboarding';
import { api, isUnauthorized } from '@/lib/api';

/** House envelope: the machine-readable code lives at err.error?.code. The twin
 * of `getPositionErrorCode` — kept here so this feature does not reach into the
 * positions hook. */
export function getTagErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

// The two tag 409 codes the calling surface renders inline (branch on the CODE
// only, never message text) — the generic toast would double-surface them.
const INLINE_CODES = new Set(['TAG_NAME_TAKEN', 'TAG_LIMIT_REACHED']);

/**
 * Mutation error handler for the tag mutations. 401 short-circuits BEFORE any
 * toast — the `api` module already navigated to /login. The inline codes render
 * in place (name field, colour swatch, per-position cap), so they get no toast;
 * every other error toasts the envelope message. Exported for tests.
 */
export function handleTagMutationError(
  err: unknown,
  showToast: (msg: string) => void,
  fallback: string,
): void {
  if (isUnauthorized(err)) return;
  if (INLINE_CODES.has(getTagErrorCode(err) ?? '')) return;
  const msg =
    typeof err === 'object' && err !== null && 'error' in err
      ? (err as { error?: { message?: string } }).error?.message
      : undefined;
  showToast(msg || fallback);
}

/**
 * The tags list as a query DEFINITION. `useTags` wraps it; a caller that needs
 * the list once reads the same cache entry through the same fetcher.
 */
export function tagsListQuery() {
  return queryOptions({
    queryKey: ['tags', 'list'],
    queryFn: () => api.get<TagWithCount[]>('/tags'),
  });
}

export function useTags() {
  return useQuery(tagsListQuery());
}

export function useCreateTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTagInput) => api.post<Tag>('/tags', input),
    onSuccess: () => {
      // A new tag changes the tags list and can be applied to positions.
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      toast.success('Tag created');
    },
    onError: (err: unknown) => {
      handleTagMutationError(err, toast.error, 'Failed to create tag');
    },
  });
}

export function useUpdateTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTagInput }) =>
      api.put<Tag>(`/tags/${id}`, data),
    onSuccess: () => {
      // A rename or recolour changes chips already rendered on the list and detail.
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      toast.success('Tag updated');
    },
    onError: (err: unknown) => {
      handleTagMutationError(err, toast.error, 'Failed to update tag');
    },
  });
}

export function useDeleteTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tags/${id}`),
    onSuccess: () => {
      // A delete removes chips already rendered on the list and detail.
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      toast.success('Tag deleted');
    },
    onError: (err: unknown) => {
      handleTagMutationError(err, toast.error, 'Failed to delete tag');
    },
  });
}

export function useSetPositionTags(positionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tagIds: string[]) => api.put<Tag[]>(`/positions/${positionId}/tags`, { tagIds }),
    onSuccess: (tags) => {
      // Seed the detail directly so the picker settles without a round trip; then
      // invalidate the list (chips) and the tags list (positionCount).
      queryClient.setQueryData<PositionDetail>(
        ['positions', 'detail', positionId],
        (d) => d && { ...d, tags },
      );
      queryClient.invalidateQueries({ queryKey: ['positions', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      toast.success('Tags updated');
    },
    onError: (err: unknown) => {
      handleTagMutationError(err, toast.error, 'Failed to update tags');
    },
  });
}

export function useAnswerStarterOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (answer: StarterAnswer['answer']) =>
      api.post<StarterAnswerResult>('/tags/starter', { answer }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
      if (result.answer === 'accept' && result.created.length > 0) {
        toast.success('Starter tags added');
      }
    },
    onError: (err: unknown) => {
      // The Add starter tags button has no inline slot, so this deliberately
      // toasts TAG_LIMIT_REACHED too (tasks Decision 2).
      if (isUnauthorized(err)) return;
      const msg =
        typeof err === 'object' && err !== null && 'error' in err
          ? (err as { error?: { message?: string } }).error?.message
          : undefined;
      toast.error(msg || 'Could not answer the starter offer');
    },
  });
}

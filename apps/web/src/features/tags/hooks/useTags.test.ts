// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { handleTagMutationError, tagsListQuery } from './useTags';

// ---------------------------------------------------------------------------
// handleTagMutationError — the shared onError for the tag mutations.
//   - the two inline 409 codes render in place, so no toast
//   - every other error toasts the envelope message (or the fallback)
//   - 401 short-circuits before any toast (the api module already redirected)
// ---------------------------------------------------------------------------

describe('handleTagMutationError', () => {
  it('suppresses the toast for both inline codes', () => {
    for (const code of ['TAG_NAME_TAKEN', 'TAG_LIMIT_REACHED']) {
      const showToast = vi.fn();
      handleTagMutationError({ status: 409, error: { code, message: 'nope' } }, showToast, 'fb');
      expect(showToast).not.toHaveBeenCalled();
    }
  });

  it('toasts the envelope message for any other error', () => {
    const showToast = vi.fn();
    handleTagMutationError(
      { status: 422, error: { code: 'VALIDATION_ERROR', message: 'Bad input' } },
      showToast,
      'fb',
    );
    expect(showToast).toHaveBeenCalledWith('Bad input');
  });

  it('falls back when no envelope message is available', () => {
    const showToast = vi.fn();
    handleTagMutationError(new Error('network down'), showToast, 'Failed to create tag');
    expect(showToast).toHaveBeenCalledWith('Failed to create tag');
  });

  it('returns early on a 401 without toasting', () => {
    const showToast = vi.fn();
    handleTagMutationError({ error: { code: 'UNAUTHORIZED' } }, showToast, 'fb');
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('tagsListQuery', () => {
  it('keys ["tags", "list"]', () => {
    expect(tagsListQuery().queryKey).toEqual(['tags', 'list']);
  });
});

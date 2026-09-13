// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TagWithCount } from '@tradr/shared';

import { TooltipProvider } from '@/components/ui/tooltip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Mocks ----------------------------------------------------------------
// The data layer is task 7's; here it is a set of controllable spies. The mock
// path resolves to the same module id that StarterTagsOffer and TagDialog import.

const h = vi.hoisted(() => ({
  tags: [] as TagWithCount[],
  isLoading: false,
  isError: false,
  onboarding: undefined as { starterTagsAnsweredAt?: string } | undefined,
  createMutateAsync: vi.fn(),
  updateMutateAsync: vi.fn(),
  deleteMutate: vi.fn(),
  answerMutate: vi.fn(),
}));

vi.mock('../hooks/useTags', () => ({
  useTags: () => ({ data: h.tags, isLoading: h.isLoading, isError: h.isError }),
  useCreateTag: () => ({ mutateAsync: h.createMutateAsync, isPending: false }),
  useUpdateTag: () => ({ mutateAsync: h.updateMutateAsync, isPending: false }),
  useDeleteTag: () => ({ mutate: h.deleteMutate }),
  useAnswerStarterOffer: () => ({ mutate: h.answerMutate, isPending: false }),
  getTagErrorCode: (err: unknown) => (err as any)?.error?.code,
}));

vi.mock('@/features/onboarding/hooks/useOnboarding', () => ({
  useOnboardingQuery: () => ({ data: h.onboarding }),
  ONBOARDING_QUERY_KEY: ['users', 'me', 'onboarding'],
}));

import { TagsSettings } from './TagsSettings';

function tag(overrides: Partial<TagWithCount> = {}): TagWithCount {
  return {
    id: 't1',
    name: 'breakout',
    category: 'setup',
    color: null,
    positionCount: 0,
    ...overrides,
  };
}

function renderSettings() {
  return render(
    <TooltipProvider>
      <TagsSettings />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  h.tags = [];
  h.isLoading = false;
  h.isError = false;
  h.onboarding = { starterTagsAnsweredAt: '2026-01-01T00:00:00.000Z' };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TagsSettings', () => {
  it('lists tags grouped under Setups, Emotions, Mistakes, General with position counts', () => {
    h.tags = [
      tag({ id: 's', name: 'breakout', category: 'setup', positionCount: 3 }),
      tag({ id: 'e', name: 'calm', category: 'emotion', positionCount: 1 }),
      tag({ id: 'm', name: 'over-sized', category: 'mistake', positionCount: 12 }),
      tag({ id: 'g', name: 'misc', category: 'general', positionCount: 0 }),
    ];
    renderSettings();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
    expect(headings).toEqual(['Setups', 'Emotions', 'Mistakes', 'General']);

    expect(screen.getByText('3 positions')).toBeTruthy();
    expect(screen.getByText('1 position')).toBeTruthy();
    expect(screen.getByText('12 positions')).toBeTruthy();
    expect(screen.getByText('0 positions')).toBeTruthy();
  });

  it('New tag opens the dialog and a valid name calls createTag.mutateAsync', async () => {
    const user = userEvent.setup();
    h.tags = [tag({ id: 's', name: 'breakout', category: 'setup', positionCount: 1 })];
    renderSettings();

    await user.click(screen.getByRole('button', { name: 'New tag' }));
    await user.type(await screen.findByLabelText('Name'), 'scalp');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(h.createMutateAsync).toHaveBeenCalledWith({
        name: 'scalp',
        category: 'setup',
        color: null,
      }),
    );
  });

  it('Edit opens the dialog prefilled and submitting calls updateTag.mutateAsync', async () => {
    const user = userEvent.setup();
    h.tags = [
      tag({ id: 't1', name: 'breakout', category: 'setup', color: 'tag-1', positionCount: 2 }),
    ];
    renderSettings();

    await user.click(screen.getByRole('button', { name: 'Actions for breakout' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    expect(screen.getByRole('heading', { name: 'Edit tag' })).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('breakout');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(h.updateMutateAsync).toHaveBeenCalledWith({
        id: 't1',
        data: { name: 'breakout', category: 'setup', color: 'tag-1' },
      }),
    );
  });

  it('Delete confirms with the tag name and count, and confirming calls deleteTag.mutate', async () => {
    const user = userEvent.setup();
    h.tags = [tag({ id: 't1', name: 'over-sized', category: 'mistake', positionCount: 12 })];
    renderSettings();

    await user.click(screen.getByRole('button', { name: 'Actions for over-sized' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('Delete «over-sized»? It will be removed from 12 positions.'),
    ).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(h.deleteMutate).toHaveBeenCalledWith('t1');
  });

  it('offer state: the starter card shows and Start from scratch answers decline', async () => {
    const user = userEvent.setup();
    h.tags = [];
    h.onboarding = { starterTagsAnsweredAt: undefined };
    renderSettings();

    expect(screen.getByText('Start with a set of tags?')).toBeTruthy();
    // The merged useAnswerStarterOffer().mutate takes a bare 'accept' | 'decline'
    // string (task 7 / task 9), not the { answer } object the prompt illustrated.
    await user.click(screen.getByRole('button', { name: 'Start from scratch' }));
    expect(h.answerMutate).toHaveBeenCalledWith('decline');
  });

  it('add-starter transition: the offer is gone and Add starter tags shows in both row-2 states', () => {
    // Row: has tags, not answered → add-starter, no prominent offer.
    h.tags = [tag({ id: 's', name: 'breakout', category: 'setup', positionCount: 1 })];
    h.onboarding = { starterTagsAnsweredAt: undefined };
    const first = renderSettings();
    expect(screen.queryByText('Start with a set of tags?')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add starter tags' })).toBeTruthy();
    first.unmount();

    // Row: no tags, answered → still add-starter, still no prominent offer.
    h.tags = [];
    h.onboarding = { starterTagsAnsweredAt: '2026-01-01T00:00:00.000Z' };
    renderSettings();
    expect(screen.queryByText('Start with a set of tags?')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add starter tags' })).toBeTruthy();
  });
});

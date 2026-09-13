// @vitest-environment jsdom
// TagPicker (design Component 13; REQ-4): a grouped checkbox list seeded from the
// position's tags, inline create posted at confirm time before the single PUT,
// errors rendered by code, and the starter offer in the row-1 state.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Tag, TagWithCount } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix dialog/select need pointer-capture + scrollIntoView, which jsdom lacks.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// Mutable hoisted state the mocked hooks read on every render.
const state = vi.hoisted(() => ({
  tags: [] as unknown[],
  onboarding: {} as Record<string, unknown>,
  setTags: vi.fn(),
  createTag: vi.fn(),
}));

// Override the hooks; keep the real `getTagErrorCode` the picker parses with.
vi.mock('../hooks/useTags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useTags')>();
  return {
    ...actual,
    useTags: () => ({ data: state.tags }),
    useSetPositionTags: () => ({ mutateAsync: state.setTags, isPending: false }),
    useCreateTag: () => ({ mutateAsync: state.createTag, isPending: false }),
    useAnswerStarterOffer: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock('@/features/onboarding/hooks/useOnboarding', () => ({
  useOnboardingQuery: () => ({ data: state.onboarding }),
  ONBOARDING_QUERY_KEY: ['users', 'me', 'onboarding'],
}));

import { TagPicker } from './TagPicker';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const NEW = '00000000-0000-0000-0000-0000000000ff';

const THREE: TagWithCount[] = [
  { id: A, name: 'breakout', category: 'setup', color: null, positionCount: 0 },
  { id: B, name: 'FOMO', category: 'emotion', color: null, positionCount: 0 },
  { id: C, name: 'chased entry', category: 'mistake', color: null, positionCount: 0 },
];

afterEach(cleanup);
beforeEach(() => {
  state.tags = [];
  state.onboarding = {};
  state.setTags = vi.fn().mockResolvedValue([]);
  state.createTag = vi.fn();
});

function renderPicker(currentTags: Tag[] = []) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TagPicker open onOpenChange={onOpenChange} positionId="p1" currentTags={currentTags} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('TagPicker', () => {
  it('ticking a second tag and saving PUTs the full set once', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    state.tags = THREE;
    renderPicker([THREE[0]]);

    await user.click(screen.getByRole('checkbox', { name: 'FOMO' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(state.setTags).toHaveBeenCalledTimes(1));
    const arg = state.setTags.mock.calls[0][0] as string[];
    expect([...arg].sort()).toEqual([A, B].sort());
  });

  it('creates an inline tag before the PUT and includes the returned id', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    state.tags = THREE;
    state.createTag = vi
      .fn()
      .mockResolvedValue({ id: NEW, name: 'my tag', category: 'setup', color: null });
    renderPicker([]);

    await user.type(screen.getByLabelText('New tag'), 'my tag');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(state.setTags).toHaveBeenCalledTimes(1));
    expect(state.createTag).toHaveBeenCalledWith({ name: 'my tag', category: 'setup' });
    expect(state.createTag.mock.invocationCallOrder[0]).toBeLessThan(
      state.setTags.mock.invocationCallOrder[0],
    );
    expect(state.setTags.mock.calls[0][0]).toContain(NEW);
  });

  it('disables inline create with the helper text at the per-position cap', () => {
    const many: TagWithCount[] = Array.from({ length: 20 }, (_, i) => ({
      id: `00000000-0000-0000-0000-0000000${String(i).padStart(5, '0')}`,
      name: `tag ${i}`,
      category: 'setup',
      color: null,
      positionCount: 0,
    }));
    state.tags = many;
    renderPicker(many);

    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This position already has 20 tags')).toBeTruthy();
  });

  it('keeps the created tag checked and shows the per-position message when the PUT is refused', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    state.onboarding = { starterTagsAnsweredAt: '2026-01-01T00:00:00.000Z' };
    state.createTag = vi
      .fn()
      .mockResolvedValue({ id: NEW, name: 'my tag', category: 'setup', color: null });
    state.setTags = vi.fn().mockRejectedValue({ error: { code: 'TAG_LIMIT_REACHED' } });
    renderPicker([]);

    await user.type(screen.getByLabelText('New tag'), 'my tag');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('This position can carry at most 20 tags')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Edit tags' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'my tag' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('softens a NOT_FOUND on the PUT into the reopen-to-refresh message', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    state.tags = THREE;
    state.setTags = vi.fn().mockRejectedValue({ error: { code: 'NOT_FOUND' } });
    renderPicker([THREE[0]]);

    await user.click(screen.getByRole('checkbox', { name: 'FOMO' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'This position or one of its tags was deleted in another tab — close and reopen to refresh',
      ),
    ).toBeTruthy();
  });

  it('shows the starter offer in place of the list in the row-1 state', () => {
    state.tags = [];
    state.onboarding = {}; // no starterTagsAnsweredAt
    renderPicker([]);

    expect(document.querySelector('[data-slot="starter-tags-offer"]')).toBeTruthy();
  });
});

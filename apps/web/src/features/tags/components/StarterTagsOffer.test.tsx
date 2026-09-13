// @vitest-environment jsdom
// StarterTagsOffer (design Component 14; REQ-6.1/6.2): the sixteen names render
// as neutral chips grouped by category, and the two actions post the answer.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STARTER_TAGS } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Hoisted mock state — assert against `mutate`.
const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));

// Mock the mutation hook (the only hook the card calls).
vi.mock('../hooks/useTags', () => ({
  useAnswerStarterOffer: () => ({ mutate, isPending: false }),
}));

import { StarterTagsOffer } from './StarterTagsOffer';

afterEach(() => cleanup());
beforeEach(() => mutate.mockClear());

describe('StarterTagsOffer', () => {
  it('renders the sixteen starter names as chips grouped by category', () => {
    render(<StarterTagsOffer variant="settings" />);
    for (const tag of STARTER_TAGS) {
      expect(screen.getByLabelText(`${tag.category}: ${tag.name}`)).toBeTruthy();
    }
  });

  it('shows the category headings in TAG_CATEGORIES order (Setups first)', () => {
    render(<StarterTagsOffer variant="settings" />);
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['Setups', 'Emotions', 'Mistakes']);
  });

  it('calls the accept path from Add the starter set', () => {
    render(<StarterTagsOffer variant="settings" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add the starter set' }));
    expect(mutate).toHaveBeenCalledWith('accept');
  });

  it('calls the decline path from Start from scratch', () => {
    render(<StarterTagsOffer variant="picker" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start from scratch' }));
    expect(mutate).toHaveBeenCalledWith('decline');
  });

  it('carries the variant on the card', () => {
    render(<StarterTagsOffer variant="picker" />);
    const card = document.querySelector('[data-slot="starter-tags-offer"]');
    expect(card?.getAttribute('data-variant')).toBe('picker');
  });
});

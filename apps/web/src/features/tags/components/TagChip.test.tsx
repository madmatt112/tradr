// @vitest-environment jsdom
// TagChip family (design Component 11; REQ-3.1, REQ-3.5, REQ-4.5): the
// accessible name, the category letter, the decorative-tint classes, the
// Unknown fallback, and the list's overflow marker.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Tag } from '@tradr/shared';

import { TooltipProvider } from '@/components/ui/tooltip';

import { TagChip, TagChipList, UnknownTagChip } from './TagChip';

afterEach(() => cleanup());

const breakout: Tag = { id: 'a', name: 'breakout', category: 'setup', color: 'tag-3' };

describe('TagChip', () => {
  it('exposes `category: name` as its accessible name and title', () => {
    render(<TagChip tag={breakout} />);
    const chip = screen.getByLabelText('setup: breakout');
    expect(chip.getAttribute('title')).toBe('setup: breakout');
  });

  it('shows the single category letter', () => {
    render(<TagChip tag={breakout} />);
    expect(screen.getByText('S')).toBeTruthy();
  });

  it('uses the neutral classes when the colour is null', () => {
    render(<TagChip tag={{ ...breakout, color: null }} />);
    const chip = screen.getByLabelText('setup: breakout');
    expect(chip.className).toContain('border-hairline');
    expect(chip.className).toContain('text-muted-foreground');
    expect(chip.className).not.toContain('bg-tag');
  });

  it('uses the decorative tint classes for a coloured tag', () => {
    render(<TagChip tag={breakout} />);
    const chip = screen.getByLabelText('setup: breakout');
    expect(chip.className).toContain('bg-tag-3/10');
    expect(chip.className).toContain('border-tag-3/40');
  });
});

describe('UnknownTagChip', () => {
  it('reads "Unknown tag" and offers a labelled remove control', () => {
    render(<UnknownTagChip id="gone" onRemove={vi.fn()} />);
    expect(screen.getByLabelText('unknown: Unknown tag')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove unknown tag from filter' })).toBeTruthy();
  });
});

describe('TagChipList', () => {
  const tags: Tag[] = [
    breakout,
    { id: 'b', name: 'pullback', category: 'setup', color: null },
    { id: 'c', name: 'calm', category: 'emotion', color: 'tag-1' },
    { id: 'd', name: 'earnings', category: 'setup', color: null },
  ];

  it('renders `max` chips then a focusable `+N` marker naming the rest', () => {
    render(
      <TooltipProvider>
        <TagChipList tags={tags} max={3} />
      </TooltipProvider>,
    );
    // The first three render as chips.
    expect(screen.getByLabelText('setup: breakout')).toBeTruthy();
    expect(screen.getByLabelText('setup: pullback')).toBeTruthy();
    expect(screen.getByLabelText('emotion: calm')).toBeTruthy();
    // The fourth collapses into a focusable marker naming it.
    const marker = screen.getByText('+1');
    expect(marker.getAttribute('aria-label')).toBe('setup: earnings');
    expect(marker.getAttribute('role')).toBe('button');
    expect(marker.getAttribute('tabindex')).toBe('0');
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(<TagChipList tags={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

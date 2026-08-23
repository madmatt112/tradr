// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PageHeader, ScopeChip } from './PageHeader';

afterEach(() => {
  cleanup();
});

describe('PageHeader', () => {
  it('renders the page name as the h1 with the mark hidden from the name', () => {
    render(<PageHeader page="Positions" />);
    // The ▴ is aria-hidden decoration; lowercase is CSS-only, so the
    // accessible name stays the properly-cased label.
    const heading = screen.getByRole('heading', { level: 1, name: 'Positions' });
    expect(heading.textContent).toContain('▴');
    expect(heading.className).toContain('lowercase');
  });

  it('renders chips beside the heading and the right cluster when given', () => {
    render(
      <PageHeader
        page="Positions"
        chips={<ScopeChip>all accounts</ScopeChip>}
        right={<span>110 total</span>}
      />,
    );
    expect(screen.getByText('all accounts')).toBeDefined();
    expect(screen.getByText('110 total')).toBeDefined();
  });

  it('always carries the drawer opener in its trailing cluster', () => {
    render(<PageHeader page="Settings" />);
    // The app-wide drawer toggle lives at the end of every header strip — the
    // slot the old 48px top bar existed for.
    expect(screen.getByRole('button', { name: 'Open side drawer' })).toBeDefined();
  });
});

describe('ScopeChip', () => {
  it('is a real button with cursor-pointer when interactive', () => {
    const onClick = vi.fn();
    render(
      <ScopeChip onClick={onClick} aria-label="Change account scope">
        all accounts ▾
      </ScopeChip>,
    );
    const chip = screen.getByRole('button', { name: 'Change account scope' });
    expect(chip.className).toContain('cursor-pointer');
    chip.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is a static span when not interactive', () => {
    render(<ScopeChip>USD</ScopeChip>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('USD').tagName).toBe('SPAN');
  });
});

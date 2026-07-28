// @vitest-environment jsdom
//
// PlatformModelPicker allowance surfaces (plan-tiers Component 12; REQ-8.9a/b):
// the allowance model is marked and ordered first ONLY when the config marks
// one (gating-gated, D16) AND tier state shows headroom; otherwise behaviour —
// including the first-priced auto-select on provider change — is byte-identical
// to the pre-tier picker (self-host parity).

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BillingModel } from '@tradr/shared';

import { PlatformModelPicker } from '../PlatformModelPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

// Rate-table order: the most expensive model first (the pre-tier auto-select
// target), the allowance model second — so ordering changes are observable.
const MARKED: BillingModel[] = [
  { providerId: 'claude', model: 'claude-opus' },
  { providerId: 'claude', model: 'claude-haiku', allowance: true },
  { providerId: 'openai', model: 'gpt-5' },
];

const UNMARKED: BillingModel[] = [
  { providerId: 'claude', model: 'claude-opus' },
  { providerId: 'claude', model: 'claude-haiku' },
  { providerId: 'openai', model: 'gpt-5' },
];

function modelOptionLabels(): (string | null)[] {
  const select = screen.getByLabelText('Model') as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.textContent);
}

describe('PlatformModelPicker allowance marking and ordering', () => {
  it('marks the allowance model and orders it first when marked + headroom (REQ-8.9a/b)', () => {
    render(
      <PlatformModelPicker
        models={MARKED}
        value={{ providerId: 'claude', model: 'claude-opus' }}
        onChange={vi.fn()}
        allowanceHeadroom
      />,
    );
    expect(modelOptionLabels()).toEqual([
      'Select a model',
      'claude-haiku — includes free monthly turns',
      'claude-opus',
    ]);
  });

  it('provider change auto-selects the allowance model when active (supersedes first-priced)', () => {
    const onChange = vi.fn();
    render(
      <PlatformModelPicker models={MARKED} value={null} onChange={onChange} allowanceHeadroom />,
    );
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      providerId: 'claude',
      model: 'claude-haiku',
      allowance: true,
    });
  });

  it('self-host (no allowance marks): no marking, provider change keeps the first-priced pick', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <PlatformModelPicker
        models={UNMARKED}
        value={{ providerId: 'claude', model: 'claude-opus' }}
        onChange={onChange}
      />,
    );
    // Original rate-table order, no free-turns marking anywhere.
    expect(modelOptionLabels()).toEqual(['Select a model', 'claude-opus', 'claude-haiku']);
    expect(document.body.textContent).not.toContain('includes free monthly turns');
    unmount();

    render(<PlatformModelPicker models={UNMARKED} value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude' } });
    expect(onChange).toHaveBeenCalledWith({ providerId: 'claude', model: 'claude-opus' });
  });

  it('marked but NO headroom (exhausted / tier query in flight): behaviour byte-identical', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <PlatformModelPicker
        models={MARKED}
        value={{ providerId: 'claude', model: 'claude-opus' }}
        onChange={onChange}
        // allowanceHeadroom omitted — the loading/self-host/exhausted default.
      />,
    );
    expect(modelOptionLabels()).toEqual(['Select a model', 'claude-opus', 'claude-haiku']);
    expect(document.body.textContent).not.toContain('includes free monthly turns');
    unmount();

    render(<PlatformModelPicker models={MARKED} value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude' } });
    // First-priced auto-select unchanged: the rate-table-first model wins.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'claude', model: 'claude-opus' }),
    );
  });
});

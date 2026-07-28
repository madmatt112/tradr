// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OptionContractInputs } from '../utils/occForm';

import { OptionContractFields } from './OptionContractFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: OptionContractInputs = { underlying: '', expiry: '', type: 'call', strike: '' };

afterEach(() => {
  cleanup();
});

describe('OptionContractFields', () => {
  it('renders the four inputs (underlying, expiry, strike, Call/Put tabs)', () => {
    render(<OptionContractFields value={BASE} onChange={vi.fn()} />);

    expect(screen.getByLabelText('Underlying')).toBeTruthy();
    expect(screen.getByLabelText('Expiry')).toBeTruthy();
    expect(screen.getByLabelText('Strike')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Call' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Put' })).toBeTruthy();
  });

  it('fires onChange with the updated underlying when typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OptionContractFields value={BASE} onChange={onChange} />);

    await user.type(screen.getByLabelText('Underlying'), 'A');

    expect(onChange).toHaveBeenLastCalledWith({ ...BASE, underlying: 'A' });
  });

  it('fires onChange with the updated strike when typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OptionContractFields value={BASE} onChange={onChange} />);

    await user.type(screen.getByLabelText('Strike'), '5');

    expect(onChange).toHaveBeenLastCalledWith({ ...BASE, strike: '5' });
  });

  it('fires onChange with type when switching the Call/Put tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OptionContractFields value={BASE} onChange={onChange} />);

    await user.click(screen.getByRole('tab', { name: 'Put' }));

    expect(onChange).toHaveBeenLastCalledWith({ ...BASE, type: 'put' });
  });

  it('renders an errors.strike message associated with the strike input', () => {
    render(
      <OptionContractFields
        value={BASE}
        onChange={vi.fn()}
        errors={{ strike: 'strike too small' }}
      />,
    );

    const strike = screen.getByLabelText('Strike') as HTMLInputElement;
    // The error is wired to the strike input via aria-describedby (adjacent + associated).
    expect(strike.getAttribute('aria-describedby')).toBe('occ-strike-error');
    expect(document.getElementById('occ-strike-error')?.textContent).toContain('strike too small');
  });

  it('renders an errors.form message in the form slot (not bound to a field)', () => {
    render(
      <OptionContractFields value={BASE} onChange={vi.fn()} errors={{ form: 'symbol too long' }} />,
    );

    const formError = document.getElementById('occ-form-error');
    expect(formError?.textContent).toContain('symbol too long');
    // The form-level error is not attached to any field input.
    expect(
      (screen.getByLabelText('Strike') as HTMLInputElement).getAttribute('aria-describedby'),
    ).toBeNull();
  });

  it('gives the expiry date input the 2000–2049 min/max bounds', () => {
    render(<OptionContractFields value={BASE} onChange={vi.fn()} />);

    const expiry = screen.getByLabelText('Expiry') as HTMLInputElement;
    expect(expiry.getAttribute('type')).toBe('date');
    expect(expiry.getAttribute('min')).toBe('2000-01-01');
    expect(expiry.getAttribute('max')).toBe('2049-12-31');
  });
});

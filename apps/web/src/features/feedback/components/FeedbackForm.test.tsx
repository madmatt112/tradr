// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FEEDBACK_TEXT_MAX_LENGTH } from '@/lib/telemetry/posthog';

import { FeedbackForm } from './FeedbackForm';

afterEach(() => {
  cleanup();
});

function sendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
}

describe('FeedbackForm', () => {
  it('disables Send until a rating is chosen, then enables it (REQ-4.4)', () => {
    render(<FeedbackForm sent={false} onSend={vi.fn()} />);
    expect(sendButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: '3' }));

    expect(screen.getByRole('radio', { name: '3' }).getAttribute('aria-checked')).toBe('true');
    expect(sendButton().disabled).toBe(false);
  });

  it('yields exactly one onSend under double-activation (REQ-4.4)', () => {
    const onSend = vi.fn();
    render(<FeedbackForm sent={false} onSend={onSend} />);
    fireEvent.click(screen.getByRole('radio', { name: '4' }));

    const send = sendButton();
    // Two activations in the same tick — the form-local sending guard must let
    // exactly one through (the disabled attribute has not re-rendered yet).
    fireEvent.click(send);
    fireEvent.click(send);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(4, '');
  });

  it('shows the remaining-character counter only under 200 remaining (REQ-4.5)', () => {
    render(<FeedbackForm sent={false} onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox', { name: 'Details (optional)' });

    // Empty: no counter.
    expect(screen.queryByText(/characters remaining/)).toBeNull();

    // Exactly 200 remaining (length 1800) — still not shown ("under 200", strict).
    fireEvent.change(textarea, { target: { value: 'a'.repeat(FEEDBACK_TEXT_MAX_LENGTH - 200) } });
    expect(screen.queryByText(/characters remaining/)).toBeNull();

    // 199 remaining (length 1801) — the counter appears.
    fireEvent.change(textarea, { target: { value: 'a'.repeat(FEEDBACK_TEXT_MAX_LENGTH - 199) } });
    expect(screen.getByText('199 characters remaining')).toBeTruthy();

    // Back under the threshold — it disappears again.
    fireEvent.change(textarea, { target: { value: 'a'.repeat(FEEDBACK_TEXT_MAX_LENGTH - 200) } });
    expect(screen.queryByText(/characters remaining/)).toBeNull();
  });

  it('resets rating and text when remounted with a new key (reopen, REQ-4.8)', () => {
    const { rerender } = render(<FeedbackForm key="open-1" sent={false} onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: '5' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Details (optional)' }), {
      target: { value: 'kept between renders only within one open' },
    });
    expect(screen.getByRole('radio', { name: '5' }).getAttribute('aria-checked')).toBe('true');

    // A new key remounts the form — the parent's per-open remount contract.
    rerender(<FeedbackForm key="open-2" sent={false} onSend={vi.fn()} />);

    for (const value of ['1', '2', '3', '4', '5']) {
      expect(screen.getByRole('radio', { name: value }).getAttribute('aria-checked')).toBe('false');
    }
    expect(
      (screen.getByRole('textbox', { name: 'Details (optional)' }) as HTMLTextAreaElement).value,
    ).toBe('');
    // No rating selected ⇒ Send disabled again.
    expect(sendButton().disabled).toBe(true);
  });

  it('swaps to the sent acknowledgement when sent is true (REQ-4.6)', () => {
    const { rerender } = render(<FeedbackForm sent={false} onSend={vi.fn()} />);
    expect(screen.queryByText('Sent. Thank you.')).toBeNull();
    rerender(<FeedbackForm sent onSend={vi.fn()} />);
    expect(screen.getByText('Sent. Thank you.')).toBeTruthy();
    // The rating group is gone in the sent state.
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

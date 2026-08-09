// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: {
    current: {
      data: { timezone: 'Europe/London', stored: true },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as Record<string, unknown>,
  },
  mutate: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezoneQuery: () => state.query.current,
  useUserTimezoneMutation: () => ({ mutate: state.mutate, isPending: false }),
}));

// Native <select> stand-in for the shadcn primitive — Radix's pointer-capture
// machinery is browser-only (same approach as BuyingPowerBasisSelect.test.tsx).
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <>
      <select
        data-testid="timezone-select"
        // A native <select> with no matching option silently selects its first
        // one, so `.value` cannot tell "no value passed" from "first option".
        // This mirrors back what the component actually passed.
        data-value={value ?? ''}
        value={value ?? ''}
        onChange={(e) => onValueChange?.(e.target.value)}
      >
        {children}
      </select>
      {/* Escape hatch. A <select> can only emit values it renders, and so can
          a Radix Select — but the component's own validation guard has to be
          reachable with an arbitrary string to be tested at all. */}
      <input data-testid="timezone-raw" onChange={(e) => onValueChange?.(e.target.value)} />
    </>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { ReportingTimezoneSelect } from './ReportingTimezoneSelect';

beforeEach(() => {
  state.query.current = {
    data: { timezone: 'Europe/London', stored: true },
    isLoading: false,
    isError: false,
    refetch: state.refetch,
  };
  state.mutate.mockClear();
  state.refetch.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ReportingTimezoneSelect', () => {
  it('displays the stored zone', () => {
    render(<ReportingTimezoneSelect />);
    expect(screen.getByTestId<HTMLSelectElement>('timezone-select').value).toBe('Europe/London');
  });

  it('saves a change through the mutation (the PUT)', () => {
    render(<ReportingTimezoneSelect />);
    fireEvent.change(screen.getByTestId('timezone-select'), { target: { value: 'Asia/Tokyo' } });
    expect(state.mutate).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('renders a stored zone the picker list omits — UTC is the server default', () => {
    // Intl.supportedValuesOf('timeZone') contains no `Etc/*` entry and no bare
    // `UTC`, yet UTC is what every pre-migration row resolves to. Without the
    // stored zone being added as an option the control would show its
    // placeholder to the largest group of users there is.
    state.query.current = {
      data: { timezone: 'UTC', stored: true },
      isLoading: false,
      isError: false,
      refetch: state.refetch,
    };
    render(<ReportingTimezoneSelect />);

    const select = screen.getByTestId<HTMLSelectElement>('timezone-select');
    expect(select.value).toBe('UTC');
    expect(Array.from(select.options).some((o) => o.value === 'UTC')).toBe(true);
    // It is offered once, not duplicated into the picker list.
    expect(Array.from(select.options).filter((o) => o.value === 'UTC').length).toBe(1);
  });

  it('does not duplicate a stored zone the picker list already contains', () => {
    render(<ReportingTimezoneSelect />);
    const select = screen.getByTestId<HTMLSelectElement>('timezone-select');
    expect(Array.from(select.options).filter((o) => o.value === 'Europe/London').length).toBe(1);
  });

  it('refuses to submit a zone that is not a real IANA name', () => {
    render(<ReportingTimezoneSelect />);
    fireEvent.change(screen.getByTestId('timezone-raw'), {
      target: { value: 'Mars/Olympus_Mons' },
    });
    expect(state.mutate).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/valid IANA timezone/i);
  });

  it('rejects the Unicode-extension bypass the shared schema catches', () => {
    // Intl would silently strip the extension and resolve this to
    // America/New_York; UserTimezoneSchema does not.
    render(<ReportingTimezoneSelect />);
    fireEvent.change(screen.getByTestId('timezone-raw'), {
      target: { value: 'America/New_York-u-ca-japanese' },
    });
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('clears the validation message once a valid zone is chosen', () => {
    render(<ReportingTimezoneSelect />);
    fireEvent.change(screen.getByTestId('timezone-raw'), { target: { value: 'nonsense' } });
    expect(document.body.textContent).toMatch(/valid IANA timezone/i);

    fireEvent.change(screen.getByTestId('timezone-select'), { target: { value: 'Asia/Tokyo' } });
    expect(state.mutate).toHaveBeenCalledWith('Asia/Tokyo');
    expect(document.body.textContent).not.toMatch(/valid IANA timezone/i);
  });

  it('states the distinction from the account trading-day timezone', () => {
    // The failure this copy exists to prevent: a user setting this one and
    // concluding they have set their accounts' trading-day zone too.
    render(<ReportingTimezoneSelect />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/not an account's trading-day timezone/i);
    expect(text).toMatch(/re-entered the same day/i);
    expect(text).toMatch(/leaves every account's trading-day timezone untouched/i);
    expect(text).toMatch(/leaves this one untouched/i);
  });

  it('describes ONLY what this zone does — it must not promise timestamp display', () => {
    // Nothing renders a timestamp in this zone: lib/format.ts uses the browser
    // zone, optionContract.ts uses UTC, reopenWindow.ts uses the ACCOUNT zone.
    // Copy describing unbuilt behaviour is the defect this assertion pins.
    render(<ReportingTimezoneSelect />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/bucketed into by day, week and month/i);
    expect(text).not.toMatch(/timestamps are shown/i);
    expect(text).not.toMatch(/timestamps are rendered/i);
  });

  it('renders a skeleton instead of a wrong value while loading', () => {
    state.query.current = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: state.refetch,
    };
    render(<ReportingTimezoneSelect />);
    expect(screen.queryByTestId('timezone-select')).toBeNull();
  });

  it('says the read failed rather than showing an empty control with no explanation', () => {
    state.query.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: state.refetch,
    };
    render(<ReportingTimezoneSelect />);

    expect(document.body.textContent).toMatch(/couldn't load your saved timezone/i);
    // The control stays usable — a PUT may succeed where the GET did not — but
    // it is handed no value, because there is no stored value to claim.
    const select = screen.getByTestId<HTMLSelectElement>('timezone-select');
    expect(select.getAttribute('data-value')).toBe('');
    fireEvent.change(select, { target: { value: 'Asia/Tokyo' } });
    expect(state.mutate).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('offers a retry that refetches', () => {
    state.query.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: state.refetch,
    };
    render(<ReportingTimezoneSelect />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.refetch).toHaveBeenCalled();
  });
});

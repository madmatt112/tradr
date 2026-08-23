// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTradeDataConsent } from '../../hooks/useTradeDataConsent';
import { AdvisorContextStrip } from '../AdvisorContextStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

vi.mock('../../hooks/useTradeDataConsent', () => ({
  useTradeDataConsent: vi.fn(),
}));

const mockConsent = vi.mocked(useTradeDataConsent);

function seeConsent(consent: boolean | undefined) {
  mockConsent.mockReturnValue({
    data: consent === undefined ? undefined : { consent },
  } as ReturnType<typeof useTradeDataConsent>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdvisorContextStrip', () => {
  it('says what the advisor can read when consent is granted, with the settings link', () => {
    seeConsent(true);
    render(<AdvisorContextStrip />);
    expect(screen.getByTestId('advisor-context-strip').textContent).toContain(
      'advisor can read: trade data ✓',
    );
    expect(screen.getByText('revocable in settings')).toBeDefined();
  });

  it('says plainly that nothing is read when consent is off', () => {
    seeConsent(false);
    render(<AdvisorContextStrip />);
    expect(screen.getByTestId('advisor-context-strip').textContent).toContain(
      'advisor reads no trade data',
    );
    expect(screen.getByText('enable in settings')).toBeDefined();
  });

  it("carries the active conversation's pinned provider and model as a chip", () => {
    seeConsent(true);
    render(
      <AdvisorContextStrip conversation={{ providerId: 'claude', model: 'claude-sonnet-5' }} />,
    );
    expect(screen.getByText('Claude · claude-sonnet-5')).toBeDefined();
  });

  it('shows no model chip without an active conversation', () => {
    seeConsent(true);
    render(<AdvisorContextStrip conversation={null} />);
    expect(screen.queryByText(/·.*claude/i)).toBeNull();
  });
});

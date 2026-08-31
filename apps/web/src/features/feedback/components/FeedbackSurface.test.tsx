// @vitest-environment jsdom
 
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  captureFeedbackDismissed,
  captureFeedbackSent,
  captureFeedbackShown,
} from '@/lib/telemetry/posthog';
import { useDrawerStore } from '@/stores/drawer.store';

// The one seam the slice touches. Mock the three capture wrappers as spies at
// the module level — FeedbackSurface is the only component that talks to
// telemetry. Keep FEEDBACK_TEXT_MAX_LENGTH real (FeedbackForm imports it).
vi.mock('@/lib/telemetry/posthog', () => ({
  captureFeedbackShown: vi.fn(),
  captureFeedbackSent: vi.fn(),
  captureFeedbackDismissed: vi.fn(),
  FEEDBACK_TEXT_MAX_LENGTH: 2000,
}));

// Controllable coarse-pointer / mobile query — the slice reads only
// '(max-width: 767px)'. Default desktop (false).
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: vi.fn(() => false),
}));

import { FeedbackSurface, feedbackMainGutterClasses } from './FeedbackSurface';

// The parsed shape of the configured survey value below.
const IDS = { surveyId: 'survey-1', ratingQuestionId: 'rating-q', textQuestionId: 'text-q' };

function configure() {
  window.__TRADR_CONFIG__ = {
    posthogPublicKey: 'phc_test',
    feedbackSurvey: `${IDS.surveyId}:${IDS.ratingQuestionId}:${IDS.textQuestionId}`,
  };
}

function setMobile(mobile: boolean) {
  vi.mocked(useMediaQuery).mockReturnValue(mobile);
}

const shown = vi.mocked(captureFeedbackShown);
const sent = vi.mocked(captureFeedbackSent);
const dismissed = vi.mocked(captureFeedbackDismissed);

beforeEach(() => {
  vi.mocked(useMediaQuery).mockReset();
  setMobile(false);
  shown.mockReset();
  sent.mockReset();
  dismissed.mockReset();
  useDrawerStore.setState({
    isOpen: false,
    activeTab: 'open-positions',
    legacyDetected: false,
    inspectedPosition: null,
  });
  configure();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.__TRADR_CONFIG__ = undefined;
});

const tab = () => screen.getByTestId('feedback-tab');

describe('FeedbackSurface — gate', () => {
  it('renders nothing and yields undefined gutter classes when unconfigured', () => {
    window.__TRADR_CONFIG__ = undefined;
    const { container } = render(<FeedbackSurface />);
    expect(container.firstChild).toBeNull();
    expect(feedbackMainGutterClasses(false)).toBeUndefined();
    expect(feedbackMainGutterClasses(true)).toBeUndefined();
  });

  it('renders the tab with the aria contract when configured, aria-controls resolving to the open content', async () => {
    const user = userEvent.setup();
    render(<FeedbackSurface />);

    const trigger = tab();
    expect(trigger.getAttribute('aria-label')).toBe('Send feedback');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await user.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const controls = trigger.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const content = document.getElementById(controls!);
    expect(content).not.toBeNull();
    expect(content).toBe(screen.getByTestId('feedback-popover'));
  });
});

describe('FeedbackSurface — survey shown', () => {
  it('fires on open, not on mount', async () => {
    const user = userEvent.setup();
    render(<FeedbackSurface />);
    expect(shown).not.toHaveBeenCalled();

    await user.click(tab());

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith(IDS);
  });
});

describe('FeedbackSurface — close funnel (exactly one dismissal per open)', () => {
  it('captures exactly one dismissal on a close without send', async () => {
    const user = userEvent.setup();
    render(<FeedbackSurface />);

    await user.click(tab());
    await user.keyboard('{Escape}');

    await waitFor(() => expect(dismissed).toHaveBeenCalledTimes(1));
    const [ids, submissionId] = dismissed.mock.calls[0];
    expect(ids).toEqual(IDS);
    expect(typeof submissionId).toBe('string');
    expect(submissionId.length).toBeGreaterThan(0);
    expect(sent).not.toHaveBeenCalled();
  });

  // fireEvent (synchronous) drives the fake-timer cases — userEvent's internal
  // delays deadlock against vitest fake timers.
  it('does not capture a dismissal on the after-send close', () => {
    vi.useFakeTimers();
    render(<FeedbackSurface />);

    fireEvent.click(tab());
    fireEvent.click(screen.getByRole('radio', { name: '3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveBeenCalledTimes(1);

    // The 3 s sent-state dwell auto-closes through the funnel; sent ⇒ no dismissal.
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(dismissed).not.toHaveBeenCalled();
    expect(screen.queryByTestId('feedback-popover')).toBeNull();
  });
});

describe('FeedbackSurface — drawer-change effect', () => {
  it('closes as exactly one dismissal on a drawerOpen flip (false → true) while open', async () => {
    const user = userEvent.setup();
    render(<FeedbackSurface />);

    await user.click(tab());
    act(() => {
      useDrawerStore.setState({ isOpen: true });
    });

    await waitFor(() => expect(dismissed).toHaveBeenCalledTimes(1));
    expect(sent).not.toHaveBeenCalled();
  });

  it('closes as exactly one dismissal on a drawerOpen flip (true → false) while open', async () => {
    act(() => {
      useDrawerStore.setState({ isOpen: true });
    });
    const user = userEvent.setup();
    render(<FeedbackSurface />);

    await user.click(tab());
    act(() => {
      useDrawerStore.setState({ isOpen: false });
    });

    await waitFor(() => expect(dismissed).toHaveBeenCalledTimes(1));
  });

  it('captures nothing when a drawerOpen flip lands during the sent dwell', () => {
    vi.useFakeTimers();
    render(<FeedbackSurface />);

    fireEvent.click(tab());
    fireEvent.click(screen.getByRole('radio', { name: '2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveBeenCalledTimes(1);

    // Drawer flips while the "Sent." state dwells — already sent, so the funnel
    // closes immediately and captures nothing.
    act(() => {
      useDrawerStore.setState({ isOpen: true });
    });
    expect(dismissed).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(dismissed).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('closes as one dismissal when isMobile flips to true with the drawer open', async () => {
    act(() => {
      useDrawerStore.setState({ isOpen: true });
    });
    setMobile(false);
    const user = userEvent.setup();
    const { rerender } = render(<FeedbackSurface />);

    await user.click(tab());

    // Resize crosses below md with the drawer open — the tab hides and the
    // popover must close.
    setMobile(true);
    rerender(<FeedbackSurface />);

    await waitFor(() => expect(dismissed).toHaveBeenCalledTimes(1));
  });

  it('does NOT close on an isMobile flip while the drawer is closed (must-not-fire)', async () => {
    setMobile(false);
    const user = userEvent.setup();
    const { rerender } = render(<FeedbackSurface />);

    await user.click(tab());
    expect(shown).toHaveBeenCalledTimes(1);

    setMobile(true);
    rerender(<FeedbackSurface />);

    // Drawer closed ⇒ the resize clause never fires; the popover stays open.
    expect(dismissed).not.toHaveBeenCalled();
    expect(screen.getByTestId('feedback-popover')).toBeTruthy();
  });

  it('still yields exactly one dismissal when a timer close races a Radix close', () => {
    vi.useFakeTimers();
    render(<FeedbackSurface />);

    fireEvent.click(tab());

    // A deferred "timer close" (a drawer flip on a timer) armed to race a Radix
    // close (a trigger re-click) of the same open. The once-per-open guard
    // collapses both to a single dismissal.
    setTimeout(() => {
      useDrawerStore.setState({ isOpen: true });
    }, 5);
    fireEvent.click(tab()); // Radix onOpenChange(false)
    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('FeedbackSurface — cross-open (REQ-4.8)', () => {
  it('two full open→rate→Send cycles emit two survey-sent captures with distinct submission ids', async () => {
    const user = userEvent.setup();
    render(<FeedbackSurface />);

    // Cycle 1.
    await user.click(tab());
    await user.click(screen.getByRole('radio', { name: '3' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    // Close the sent state without waiting on the dwell timer.
    await user.keyboard('{Escape}');

    // Cycle 2 — a fresh open remounts the form, resetting its guard.
    await user.click(tab());
    await user.click(screen.getByRole('radio', { name: '4' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(sent).toHaveBeenCalledTimes(2);
    expect(dismissed).not.toHaveBeenCalled();

    const firstSubmissionId = sent.mock.calls[0][1];
    const secondSubmissionId = sent.mock.calls[1][1];
    expect(typeof firstSubmissionId).toBe('string');
    expect(firstSubmissionId).not.toBe(secondSubmissionId);
    // Ratings carried through per cycle.
    expect(sent.mock.calls[0][2]).toBe(3);
    expect(sent.mock.calls[1][2]).toBe(4);
  });
});

describe('FeedbackSurface — mount silence', () => {
  it('emits nothing when mounted with persisted-open drawer state on a phone', () => {
    act(() => {
      useDrawerStore.setState({ isOpen: true });
    });
    setMobile(true);

    render(<FeedbackSurface />);

    expect(shown).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(dismissed).not.toHaveBeenCalled();
  });
});

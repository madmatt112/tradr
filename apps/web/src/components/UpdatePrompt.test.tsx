// @vitest-environment jsdom
//
// The prompt is deliberately dumb: it turns the monitor's snapshot into one
// sonner toast (id `app-update`) and forwards three intents — shown, accepted,
// dismissed. These tests stub sonner, the router and PostHog, and drive a fake
// getUpdateMonitor so every branch of the toast lifecycle is exercised without a
// real monitor, DOM or timer.
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureClientEvent } from '@/lib/telemetry/posthog';
import type { MonitorSnapshot } from '@/lib/updateMonitor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// sonner: `toast` is a callable with a `.dismiss` method (invalidTimezone.test.tsx:28).
const { toastMock, dismissMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  dismissMock: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(toastMock, { dismiss: dismissMock }),
}));

// useRouter is only handed to monitor.start; a minimal stub is enough (Sidebar.test.tsx).
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ subscribe: () => () => {} }),
}));

// PostHog capture is a no-op we assert on (ChartWidget.height.test.tsx:70).
vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

// A single fake monitor both useUpdateMonitor and UpdatePrompt reach through the
// mocked getUpdateMonitor; `snapshot` is swapped and listeners fired to drive
// state transitions.
const monitorState = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    snapshot: undefined as unknown as MonitorSnapshot,
    listeners,
    monitor: {
      start: vi.fn(),
      stop: vi.fn(),
      check: vi.fn(),
      dismiss: vi.fn(),
      accept: vi.fn(),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getSnapshot: () => state.snapshot,
    },
  };
  return state;
});
vi.mock('@/lib/updateMonitor', () => ({
  getUpdateMonitor: () => monitorState.monitor,
}));


import { UPDATE_TOAST_ID, UpdatePrompt } from './UpdatePrompt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOOT = 'v0.13.0';

function pollingSnapshot(): MonitorSnapshot {
  return { phase: 'polling', bootVersion: BOOT, promptVisible: false };
}

function updateSnapshot(
  served: string,
  opts: { visible?: boolean; learnedVia?: 'poll' | 'broadcast' } = {},
): MonitorSnapshot {
  return {
    phase: 'update-available',
    bootVersion: BOOT,
    servedVersion: served,
    learnedVia: opts.learnedVia ?? 'poll',
    promptVisible: opts.visible ?? true,
  };
}

function setSnapshot(next: MonitorSnapshot) {
  act(() => {
    monitorState.snapshot = next;
    for (const listener of monitorState.listeners) listener();
  });
}

/** The options object of the Nth `toast(...)` call. */
function toastOpts(call = 0): Record<string, unknown> {
  return toastMock.mock.calls[call]?.[1] as Record<string, unknown>;
}

function shownCalls() {
  return vi.mocked(captureClientEvent).mock.calls.filter((c) => c[0] === 'app_update_prompt_shown');
}

function dismissedCalls() {
  return vi
    .mocked(captureClientEvent)
    .mock.calls.filter((c) => c[0] === 'app_update_prompt_dismissed');
}

beforeEach(() => {
  vi.clearAllMocks();
  monitorState.listeners.clear();
  monitorState.snapshot = pollingSnapshot();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdatePrompt', () => {
  it('renders null and mounts nothing to the DOM', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1');
    const { container } = render(<UpdatePrompt />);
    expect(container.innerHTML).toBe('');
  });

  it('starts the monitor with the router on mount and stops it on unmount', () => {
    monitorState.snapshot = pollingSnapshot();
    const { unmount } = render(<UpdatePrompt />);
    expect(monitorState.monitor.start).toHaveBeenCalled();
    expect(monitorState.monitor.start.mock.calls[0][0]).toHaveProperty('router');
    unmount();
    expect(monitorState.monitor.stop).toHaveBeenCalled();
  });

  it('issues one toast with the pinned id, Infinity duration, both labels and cursor-pointer classNames (no bg-primary)', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1');
    render(<UpdatePrompt />);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toBe('Tradr has been updated');
    const opts = toastOpts();
    expect(opts.id).toBe(UPDATE_TOAST_ID);
    expect(opts.duration).toBe(Infinity);
    expect(opts.dismissible).toBe(true);
    expect((opts.action as { label: string }).label).toBe('Reload');
    expect((opts.cancel as { label: string }).label).toBe('Not now');
    expect(opts.classNames).toEqual({
      actionButton: 'cursor-pointer',
      cancelButton: 'cursor-pointer',
    });
    expect(JSON.stringify(opts.classNames)).not.toContain('bg-primary');
  });

  it('captures app_update_prompt_shown exactly once under StrictMode', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1', { learnedVia: 'poll' });
    render(
      <StrictMode>
        <UpdatePrompt />
      </StrictMode>,
    );

    expect(shownCalls()).toHaveLength(1);
    expect(shownCalls()[0][1]).toMatchObject({
      bootVersion: BOOT,
      servedVersion: 'v0.13.1',
      learnedVia: 'poll',
    });
  });

  it('on Reload captures app_update_prompt_accepted then calls monitor.accept()', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1');
    render(<UpdatePrompt />);

    const action = toastOpts().action as { onClick: () => void };
    act(() => action.onClick());

    expect(captureClientEvent).toHaveBeenCalledWith('app_update_prompt_accepted', {
      bootVersion: BOOT,
      servedVersion: 'v0.13.1',
    });
    expect(monitorState.monitor.accept).toHaveBeenCalledTimes(1);
    const acceptedOrder = vi.mocked(captureClientEvent).mock.invocationCallOrder.at(-1) ?? 0;
    const monitorOrder = monitorState.monitor.accept.mock.invocationCallOrder[0];
    expect(acceptedOrder).toBeLessThan(monitorOrder);
  });

  it('on the Not now button captures app_update_prompt_dismissed and calls monitor.dismiss()', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1');
    render(<UpdatePrompt />);

    const cancel = toastOpts().cancel as { onClick: () => void };
    act(() => cancel.onClick());

    expect(captureClientEvent).toHaveBeenCalledWith('app_update_prompt_dismissed', {
      bootVersion: BOOT,
      servedVersion: 'v0.13.1',
    });
    expect(monitorState.monitor.dismiss).toHaveBeenCalledTimes(1);
  });

  it('on a genuine onDismiss captures app_update_prompt_dismissed and calls monitor.dismiss()', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1');
    render(<UpdatePrompt />);

    const onDismiss = toastOpts().onDismiss as () => void;
    act(() => onDismiss());

    expect(dismissedCalls()).toHaveLength(1);
    expect(monitorState.monitor.dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not capture dismissed for a programmatic toast.dismiss, but does for a genuine dismiss of a new served version', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1');
    render(<UpdatePrompt />);
    const firstOnDismiss = toastOpts(0).onDismiss as () => void;

    // The prompt hides without a user action (state flips to not-visible): we
    // dismiss programmatically, then sonner echoes that back through onDismiss.
    setSnapshot(updateSnapshot('v0.13.1', { visible: false }));
    expect(dismissMock).toHaveBeenCalledWith(UPDATE_TOAST_ID);
    act(() => firstOnDismiss());
    expect(dismissedCalls()).toHaveLength(0);

    // A different served version issues a fresh toast whose genuine dismiss captures.
    setSnapshot(updateSnapshot('v0.13.2', { visible: true }));
    const secondOnDismiss = toastOpts(1).onDismiss as () => void;
    act(() => secondOnDismiss());
    expect(dismissedCalls()).toHaveLength(1);
    expect(dismissedCalls()[0][1]).toMatchObject({ servedVersion: 'v0.13.2' });
  });

  it('re-issues the toast with the same id when the served version changes', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1');
    render(<UpdatePrompt />);
    expect(toastMock).toHaveBeenCalledTimes(1);

    setSnapshot(updateSnapshot('v0.13.2'));
    expect(toastMock).toHaveBeenCalledTimes(2);
    expect(toastOpts(0).id).toBe(UPDATE_TOAST_ID);
    expect(toastOpts(1).id).toBe(UPDATE_TOAST_ID);
  });

  // F3 rows (design round 2): mounting in `polling` must not fire a stray
  // toast.dismiss or strand programmaticDismissRef, so the first genuine
  // dismissal of the first prompt still captures — the v2 stuck-flag regression.
  it('mounting in polling fires no toast.dismiss and does not strand the dismiss flag', () => {
    monitorState.snapshot = pollingSnapshot();
    render(<UpdatePrompt />);
    expect(toastMock).not.toHaveBeenCalled();
    expect(dismissMock).not.toHaveBeenCalled();

    // First update: a toast is issued; its first genuine dismiss must capture.
    setSnapshot(updateSnapshot('v0.13.1', { visible: true }));
    const onDismiss = toastOpts(0).onDismiss as () => void;
    act(() => onDismiss());
    expect(dismissedCalls()).toHaveLength(1);
    expect(monitorState.monitor.dismiss).toHaveBeenCalledTimes(1);
  });

  it('after a dismissal a new served version issues a fresh toast and captures shown again', () => {
    monitorState.snapshot = updateSnapshot('v0.13.1');
    render(<UpdatePrompt />);
    expect(shownCalls()).toHaveLength(1);

    // Dismissed: the prompt hides for this served version.
    setSnapshot(updateSnapshot('v0.13.1', { visible: false }));
    expect(dismissMock).toHaveBeenCalledWith(UPDATE_TOAST_ID);

    // A new served version issues a fresh toast and captures shown a second time.
    setSnapshot(updateSnapshot('v0.13.2', { visible: true }));
    expect(shownCalls()).toHaveLength(2);
    expect(shownCalls()[1][1]).toMatchObject({ servedVersion: 'v0.13.2' });
    expect(toastMock.mock.calls.at(-1)?.[1]).toMatchObject({ id: UPDATE_TOAST_ID });
  });
});

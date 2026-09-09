// @vitest-environment jsdom
import { Component, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetChunkRecoveryForTests,
  attemptAutomaticReload,
  installChunkRecovery,
  reloadAfterChunkFailure,
} from '@/lib/chunkRecovery';

import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { ChunkLoadFallback } from './ChunkLoadFallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock the recovery module so the guard/helper rows can drive the boundary
// without a real reload. `isChunkLoadError` (and `installChunkRecovery` /
// `__resetChunkRecoveryForTests`) stay real, sharing the module's internal
// tagged-error WeakSet, so the identity path can be exercised end-to-end; only
// the two side-effecting helpers become spies.
vi.mock('@/lib/chunkRecovery', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chunkRecovery')>('@/lib/chunkRecovery');
  return {
    ...actual,
    attemptAutomaticReload: vi.fn(() => false),
    reloadAfterChunkFailure: vi.fn(() => Promise.resolve()),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountWith(ui: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

function unmount(container: HTMLElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function ThrowError({ error }: { error: unknown }): never {
  throw error;
}

// Mirrors what the root error boundary does: capture a rethrown error and
// surface its message, so the rethrow path is observable.
class TestParentBoundary extends Component<{ children: ReactNode }, { caught: Error | null }> {
  state = { caught: null as Error | null };
  static getDerivedStateFromError(error: Error): { caught: Error } {
    return { caught: error };
  }
  componentDidCatch(): void {
    // swallow — the test asserts the rendered fallback
  }
  render(): ReactNode {
    if (this.state.caught) {
      return <div data-testid="parent-boundary-fallback">{this.state.caught.message}</div>;
    }
    return this.props.children;
  }
}

const CHROMIUM_MESSAGE = 'Failed to fetch dynamically imported module: /assets/chart-abc.js';
const SAFARI_MESSAGE = 'Importing a module script failed.';

beforeEach(() => {
  sessionStorage.clear();
  __resetChunkRecoveryForTests();
  vi.mocked(attemptAutomaticReload).mockReset();
  vi.mocked(attemptAutomaticReload).mockReturnValue(false);
  vi.mocked(reloadAfterChunkFailure).mockReset();
  vi.mocked(reloadAfterChunkFailure).mockResolvedValue(undefined);
});

afterEach(() => {
  __resetChunkRecoveryForTests();
  vi.restoreAllMocks();
});

describe('ChunkErrorBoundary — classification', () => {
  it('renders the fallback for the Chromium "Failed to fetch dynamically imported module" message', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountWith(
      <ChunkErrorBoundary fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}>
        <ThrowError error={new Error(CHROMIUM_MESSAGE)} />
      </ChunkErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="chunk-load-fallback"]')).not.toBeNull();
    unmount(container, root);
    errSpy.mockRestore();
  });

  it('renders the fallback for the Safari "Importing a module script failed" message', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountWith(
      <ChunkErrorBoundary fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}>
        <ThrowError error={new Error(SAFARI_MESSAGE)} />
      </ChunkErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="chunk-load-fallback"]')).not.toBeNull();
    unmount(container, root);
    errSpy.mockRestore();
  });

  it('renders the children when there is no error', () => {
    const { container, root } = mountWith(
      <ChunkErrorBoundary fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}>
        <div data-testid="child" />
      </ChunkErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="child"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chunk-load-fallback"]')).toBeNull();
    unmount(container, root);
  });

  it('rethrows a non-chunk error so a parent boundary catches it', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountWith(
      <TestParentBoundary>
        <ChunkErrorBoundary fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}>
          <ThrowError error={new Error('totally unrelated bug')} />
        </ChunkErrorBoundary>
      </TestParentBoundary>,
    );
    const fallback = container.querySelector('[data-testid="parent-boundary-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe('totally unrelated bug');
    expect(container.querySelector('[data-testid="chunk-load-fallback"]')).toBeNull();
    unmount(container, root);
    errSpy.mockRestore();
  });

  it('renders the fallback for a tagged error whose message matches no wording', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Tag the error by identity through the real listener — its message would
    // never match the regex, so only the WeakSet identity path can classify it.
    installChunkRecovery({ capture: () => {}, nudge: () => {} });
    const tagged = new Error('a wording no browser ever produced');
    const event = new Event('vite:preloadError');
    (event as { payload?: unknown }).payload = tagged;
    window.dispatchEvent(event);

    const { container, root } = mountWith(
      <ChunkErrorBoundary fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}>
        <ThrowError error={tagged} />
      </ChunkErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="chunk-load-fallback"]')).not.toBeNull();
    unmount(container, root);
    errSpy.mockRestore();
  });
});

describe('ChunkErrorBoundary — recovery', () => {
  it("recovery='reload' with the guard permitting reloads once and renders the reloading node", () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(attemptAutomaticReload).mockReturnValue(true);
    const { container, root } = mountWith(
      <ChunkErrorBoundary
        fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}
        reloading={<div data-testid="reloading-sentinel" />}
      >
        <ThrowError error={new Error(CHROMIUM_MESSAGE)} />
      </ChunkErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="reloading-sentinel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chunk-load-fallback"]')).toBeNull();
    expect(vi.mocked(attemptAutomaticReload)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reloadAfterChunkFailure)).toHaveBeenCalledTimes(1);
    unmount(container, root);
    errSpy.mockRestore();
  });

  it("recovery='reload' with the guard spent renders the fallback whose reload calls the helper", () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(attemptAutomaticReload).mockReturnValue(false);
    const { container, root } = mountWith(
      <ChunkErrorBoundary
        fallback={({ reload }) => (
          <button type="button" data-testid="manual-reload" onClick={reload}>
            Reload
          </button>
        )}
      >
        <ThrowError error={new Error(CHROMIUM_MESSAGE)} />
      </ChunkErrorBoundary>,
    );
    const button = container.querySelector<HTMLButtonElement>('[data-testid="manual-reload"]');
    expect(button).not.toBeNull();
    expect(vi.mocked(reloadAfterChunkFailure)).not.toHaveBeenCalled();
    act(() => {
      button!.click();
    });
    expect(vi.mocked(reloadAfterChunkFailure)).toHaveBeenCalledTimes(1);
    unmount(container, root);
    errSpy.mockRestore();
  });

  it("recovery='inline' renders the fallback and never calls the reload helpers", () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountWith(
      <ChunkErrorBoundary
        recovery="inline"
        fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}
      >
        <ThrowError error={new Error(CHROMIUM_MESSAGE)} />
      </ChunkErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="chunk-load-fallback"]')).not.toBeNull();
    expect(vi.mocked(attemptAutomaticReload)).not.toHaveBeenCalled();
    expect(vi.mocked(reloadAfterChunkFailure)).not.toHaveBeenCalled();
    unmount(container, root);
    errSpy.mockRestore();
  });

  it('two sibling boundaries failing together reload only once', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    vi.mocked(attemptAutomaticReload).mockImplementation(() => calls++ === 0);
    const { container, root } = mountWith(
      <>
        <ChunkErrorBoundary
          fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}
          reloading={<div data-testid="reloading-a" />}
        >
          <ThrowError
            error={new Error('Failed to fetch dynamically imported module: /assets/a.js')}
          />
        </ChunkErrorBoundary>
        <ChunkErrorBoundary
          fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}
          reloading={<div data-testid="reloading-b" />}
        >
          <ThrowError
            error={new Error('Failed to fetch dynamically imported module: /assets/b.js')}
          />
        </ChunkErrorBoundary>
      </>,
    );
    expect(vi.mocked(attemptAutomaticReload)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(reloadAfterChunkFailure)).toHaveBeenCalledTimes(1);
    unmount(container, root);
    errSpy.mockRestore();
  });
});

describe('ChunkLoadFallback — a11y variants', () => {
  it('renders the compact fallback with role="status" and no description', () => {
    const { container, root } = mountWith(<ChunkLoadFallback onReload={() => {}} compact />);
    const el = container.querySelector('[data-testid="chunk-load-fallback"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('status');
    expect(container.querySelector('[data-slot="alert-description"]')).toBeNull();
    expect(container.querySelector('[data-testid="chunk-load-fallback-reload"]')).not.toBeNull();
    unmount(container, root);
  });

  it('renders the non-compact fallback with aria-live="assertive" and a description', () => {
    const { container, root } = mountWith(<ChunkLoadFallback onReload={() => {}} />);
    const el = container.querySelector('[data-testid="chunk-load-fallback"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-live')).toBe('assertive');
    expect(container.querySelector('[data-slot="alert-description"]')).not.toBeNull();
    unmount(container, root);
  });
});

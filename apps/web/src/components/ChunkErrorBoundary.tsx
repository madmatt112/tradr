import { Component, type ReactNode } from 'react';

import {
  attemptAutomaticReload,
  isChunkLoadError,
  reloadAfterChunkFailure,
} from '@/lib/chunkRecovery';

export interface ChunkErrorBoundaryProps {
  children: ReactNode;
  /**
   * 'reload' (default): on a chunk failure, reload once automatically if the
   * guard permits, otherwise render `fallback`.
   * 'inline': never reload automatically — render `fallback` immediately and
   * leave any reload to the user (or the update prompt).
   */
  recovery?: 'reload' | 'inline';
  /** Rendered when the guard is spent, or immediately for recovery='inline'. */
  fallback: (props: { error: Error; reload: () => void }) => ReactNode;
  /**
   * Rendered for the instant between deciding to reload and the navigation. No
   * production mount site supplies one (the default `null` is imperceptible
   * before the document reloads); it exists for the unit test.
   */
  reloading?: ReactNode;
}

type State =
  | { kind: 'idle' }
  | { kind: 'chunk'; error: Error }
  | { kind: 'rethrow'; error: Error }
  | { kind: 'reloading' };

/**
 * Shared error boundary for every lazy site. A rejected `import()` — a chunk
 * that vanished when a deploy replaced the running build — is recognised by
 * {@link isChunkLoadError} (identity first, wording second) and turned into a
 * stated failure with a recovery. Any other error is re-thrown from `render()`
 * so the next boundary above (the root `errorComponent`) handles it.
 *
 * Generalised from the chart boundary that used to live in PerformancePage: the
 * reload decision, the one-reload guard and the cache-refresh-then-reload
 * helper all live in `lib/chunkRecovery`, never re-implemented here.
 */
export class ChunkErrorBoundary extends Component<ChunkErrorBoundaryProps, State> {
  state: State = { kind: 'idle' };

  static getDerivedStateFromError(error: unknown): State {
    // Coerce non-Error throwables so both branches carry a real Error. React
    // only ever surfaces `unknown` here.
    const err = error instanceof Error ? error : new Error(String(error));
    if (isChunkLoadError(error)) return { kind: 'chunk', error: err };
    return { kind: 'rethrow', error: err };
  }

  componentDidCatch(error: Error): void {
    if (this.state.kind !== 'chunk') return;
    if ((this.props.recovery ?? 'reload') !== 'reload') return;
    // The first boundary to fail consumes the guard and reloads; any sibling
    // that fails in the same render finds it spent and renders its fallback.
    if (attemptAutomaticReload()) {
      this.setState({ kind: 'reloading' });
      void reloadAfterChunkFailure(error);
    }
  }

  render(): ReactNode {
    const { state, props } = this;
    switch (state.kind) {
      case 'rethrow':
        // Throwing from `render()` lets React propagate the error to the next
        // boundary above, rather than re-rendering children that already threw.
        throw state.error;
      case 'reloading':
        return props.reloading ?? null;
      case 'chunk':
        return props.fallback({
          error: state.error,
          reload: () => void reloadAfterChunkFailure(state.error),
        });
      default:
        return props.children;
    }
  }
}

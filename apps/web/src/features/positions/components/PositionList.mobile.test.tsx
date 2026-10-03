// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Hoisted spies: the row-click branch (design C6 item 1, Requirement 6.3/6.9)
// either navigates to the detail route or opens the inspect drawer, depending
// on `useMediaQuery('(max-width: 767px)')`. Both collaborators are mocked so
// the assertion reaches only the branch, never a real router or store.
const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  inspectPosition: vi.fn(),
  mediaQuery: vi.fn<(query: string) => boolean>(() => false),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  useNavigate: () => h.navigate,
  useSearch: () => ({}),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => h.mediaQuery(query),
}));

vi.mock('@/stores/drawer.store', () => ({
  useDrawerStore: (selector: (s: unknown) => unknown) =>
    selector({ inspectPosition: h.inspectPosition, inspectedPosition: null, isOpen: false }),
}));

vi.mock('@/features/tags/hooks/useTags', () => ({
  useTags: () => ({ data: [] }),
}));

vi.mock('./PositionRowActions', () => ({
  PositionRowActions: () => null,
}));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: 'a1' }] }),
}));

const position = makePosition({ id: 'pos-mobile-1' });

vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: () => ({ data: [position], isLoading: false }),
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

vi.mock('./CreatePositionDialog', () => ({
  CreatePositionDialog: () => null,
}));

import { PositionList } from './PositionList';

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

// The Side chip cell: not the symbol link, not the action strip, so
// `shouldNavigateFromRowClick` treats a click on it as a row click.
function clickRow(container: HTMLElement): void {
  const cell = container.querySelectorAll('tbody tr td')[1] as HTMLElement;
  act(() => {
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  });
}

afterEach(() => {
  vi.clearAllMocks();
  h.mediaQuery.mockReturnValue(false);
});

describe('PositionList — row click below 768px (design C6 item 1)', () => {
  it('navigates to the detail route and does not open the inspect drawer when mobile', () => {
    h.mediaQuery.mockReturnValue(true);
    const { container, root } = mountWith(<PositionList />);

    clickRow(container);

    expect(h.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/positions/$positionId',
        params: { positionId: position.id },
      }),
    );
    expect(h.inspectPosition).not.toHaveBeenCalled();

    unmount(container, root);
  });

  it('opens the inspect drawer on desktop widths (Requirement 6.9)', () => {
    h.mediaQuery.mockReturnValue(false);
    const { container, root } = mountWith(<PositionList />);

    clickRow(container);

    expect(h.inspectPosition).toHaveBeenCalledWith(position);
    expect(h.navigate).not.toHaveBeenCalled();

    unmount(container, root);
  });
});

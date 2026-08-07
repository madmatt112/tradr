// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePosition } from '../hooks/usePosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock('../hooks/usePosition', () => ({
  usePosition: vi.fn(),
  useDeletePosition: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useOpenPosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useClosePosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useReopenPosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('./FillDialog', () => ({ FillDialog: () => null }));
vi.mock('./FillTable', () => ({ FillTable: () => null }));
vi.mock('./PositionEditDialog', () => ({ PositionEditDialog: () => null }));
// The Fills-header coach mark (user-onboarding R7.1) reads onboarding state
// through TanStack Query; this file mounts bare, with no QueryClient. Its own
// suite covers it — this file is about the P&L figures.
vi.mock('@/features/onboarding/components/CoachMark', () => ({ CoachMark: () => null }));

import { PositionDetailView } from './PositionDetail';

type PositionResult = ReturnType<typeof usePosition>;

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

afterEach(() => {
  vi.clearAllMocks();
});

function mockDetail(pnl: {
  grossPnl: number | null;
  netPnl: number | null;
  ret: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  targetRR?: number | null;
  actualRR?: number | null;
}) {
  vi.mocked(usePosition).mockReturnValue({
    data: {
      id: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000100',
      accountId: '00000000-0000-0000-0000-000000000010',
      accountTimezone: 'America/New_York',
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      notes: null,
      openedAt: '2026-05-01T12:00:00.000Z',
      closedAt: '2026-05-02T12:00:00.000Z',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-02T12:00:00.000Z',
      fills: [],
      avgEntryPrice: 150,
      avgExitPrice: 160,
      totalEntryQuantity: 100,
      totalExitQuantity: 100,
      realizedPnl: pnl.netPnl,
      returnPercentage: pnl.ret,
      brokerageName: null,
      grossPnl: pnl.grossPnl,
      brokerageFees: 0,
      netPnl: pnl.netPnl,
      targetPrice: pnl.targetPrice ?? null,
      stopLoss: pnl.stopLoss ?? null,
      targetRR: pnl.targetRR ?? null,
      actualRR: pnl.actualRR ?? null,
      openUnits: 0,
      closedUnits: 0,
    },
    isLoading: false,
  } as unknown as PositionResult);
}

/** Return the <Numeric> element inside the summary card with the given title. */
function cardNumeric(container: HTMLElement, title: string): HTMLElement {
  const titleEl = Array.from(container.querySelectorAll('[data-slot="card-title"]')).find(
    (el) => el.textContent === title,
  );
  const numeric = titleEl?.closest('[data-slot="card"]')?.querySelector('[data-testid="numeric"]');
  if (!numeric) throw new Error(`No <Numeric> found in card "${title}"`);
  return numeric as HTMLElement;
}

/** The 3 P&L figures (Gross, Net, Return %) all render through <Numeric>. */
function pnlNumerics(container: HTMLElement): HTMLElement[] {
  return ['Gross P&L', 'Net P&L', 'Return %'].map((title) => cardNumeric(container, title));
}

describe('PositionDetail — P&L renders via <Numeric>', () => {
  it('gain: every P&L figure carries + / text-gain, no arrow glyph', () => {
    mockDetail({ grossPnl: 200, netPnl: 195, ret: 12.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const nums = pnlNumerics(container);
    expect(nums.length).toBe(3);
    for (const n of nums) {
      expect(n.getAttribute('data-state')).toBe('gain');
      expect(n.className).toContain('text-gain');
      expect(n.textContent).toContain('+');
      expect(n.querySelector('svg')).toBeNull();
    }
    unmount(container, root);
  });

  it('loss: every P&L figure carries − / text-loss, no arrow glyph', () => {
    mockDetail({ grossPnl: -200, netPnl: -195, ret: -12.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const nums = pnlNumerics(container);
    for (const n of nums) {
      expect(n.getAttribute('data-state')).toBe('loss');
      expect(n.className).toContain('text-loss');
      expect(n.textContent).toContain('−'); // U+2212
      expect(n.querySelector('svg')).toBeNull();
    }
    unmount(container, root);
  });

  it('flat: every P&L figure renders the literal zero with no marker', () => {
    mockDetail({ grossPnl: 0, netPnl: 0, ret: 0 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const nums = pnlNumerics(container);
    for (const n of nums) {
      expect(n.getAttribute('data-state')).toBe('flat');
      expect(n.textContent).not.toContain('—');
    }
    unmount(container, root);
  });

  it('absent: every P&L figure renders the em-dash with no glyph', () => {
    mockDetail({ grossPnl: null, netPnl: null, ret: null });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const nums = pnlNumerics(container);
    for (const n of nums) {
      expect(n.getAttribute('data-state')).toBe('absent');
      expect(n.textContent).toContain('—');
      expect(n.querySelector('svg')).toBeNull();
    }
    unmount(container, root);
  });
});

describe('PositionDetail — R/R + target-price cards', () => {
  it('renders values: Target R/R neutral, Actual R/R sign-colored', () => {
    mockDetail({
      grossPnl: 200,
      netPnl: 195,
      ret: 12.5,
      targetPrice: 165,
      targetRR: 1.5,
      actualRR: 1,
    });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    const targetPrice = cardNumeric(container, 'Target Price');
    expect(targetPrice.getAttribute('data-state')).toBe('neutral');

    const targetRR = cardNumeric(container, 'Target R/R');
    expect(targetRR.getAttribute('data-state')).toBe('neutral');
    expect(targetRR.textContent).toContain('1.50');

    // actualRR uses direction="auto" — positive reads as a gain with a leading +.
    const actualRR = cardNumeric(container, 'Actual R/R');
    expect(actualRR.getAttribute('data-state')).toBe('gain');
    expect(actualRR.textContent).toContain('+');

    unmount(container, root);
  });

  it('signs a losing Actual R/R with − / text-loss', () => {
    mockDetail({ grossPnl: -50, netPnl: -55, ret: -3, actualRR: -0.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    const actualRR = cardNumeric(container, 'Actual R/R');
    expect(actualRR.getAttribute('data-state')).toBe('loss');
    expect(actualRR.className).toContain('text-loss');
    expect(actualRR.textContent).toContain('−'); // U+2212

    unmount(container, root);
  });

  it('renders "—" for null Target Price / Target R/R / Actual R/R', () => {
    mockDetail({ grossPnl: null, netPnl: null, ret: null });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    for (const title of ['Target Price', 'Target R/R', 'Actual R/R']) {
      const el = cardNumeric(container, title);
      expect(el.getAttribute('data-state')).toBe('absent');
      expect(el.textContent).toContain('—');
    }

    unmount(container, root);
  });
});

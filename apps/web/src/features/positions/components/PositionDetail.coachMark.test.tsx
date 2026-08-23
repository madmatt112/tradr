// @vitest-environment jsdom
//
// The one PositionDetail suite that keeps the coach mark REAL.
//
// The other three stub it to null, and rightly: they mount this component bare
// with no QueryClient, and none of them is about onboarding. But that leaves
// `available={!isClosed}` asserted nowhere — a stub renders nothing whatever
// the prop says, so the gate could be inverted, dropped or hard-coded and all
// three would stay green.
//
// So this file fakes only the two cheap hooks the mark reads, exactly as
// `CoachMark.test.tsx` does, and mounts the real component against the two
// position states the gate distinguishes. The claim under test belongs to
// PositionDetail — that a closed position, which renders no Add Fill button,
// gets no mark introducing one.
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState, PositionDetail } from '@tradr/shared';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useOnboardingQuery, useOnboardingPatch } from '@/features/onboarding/hooks/useOnboarding';

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

// CoachMark reads the signed-in user's id for its device latch; a static stub
// keeps the surface mountable without the auth stack.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'test@example.com' } }),
}));

vi.mock('./FillDialog', () => ({ FillDialog: () => null }));
vi.mock('./FillTable', () => ({ FillTable: () => null }));
vi.mock('./PositionEditDialog', () => ({ PositionEditDialog: () => null }));

// The mark's reads, and nothing else. `useOnboarding.test.ts` owns the round
// trip; faking the query here is what lets this file mount with no QueryClient
// while leaving the component itself untouched.
vi.mock('@/features/onboarding/hooks/useOnboarding', () => ({
  useOnboardingQuery: vi.fn(),
  useOnboardingPatch: vi.fn(),
  useOnboarding: vi.fn(),
}));
vi.mock('@/features/onboarding/hooks/useWalkthrough', () => ({
  useIsWalkthroughRunning: vi.fn(() => false),
}));

import { PositionDetailView } from './PositionDetail';

const mockQuery = vi.mocked(useOnboardingQuery);
const mockPatch = vi.mocked(useOnboardingPatch);

function renderDetail() {
  return render(
    <TooltipProvider>
      <PositionDetailView positionId="p1" />
    </TooltipProvider>,
  );
}

type PositionResult = ReturnType<typeof usePosition>;

const TODAY_UTC = new Date().toISOString().slice(0, 10);

function makeDetail(overrides: Partial<PositionDetail> = {}): PositionDetail {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    userId: '00000000-0000-0000-0000-000000000100',
    accountId: '00000000-0000-0000-0000-000000000010',
    accountTimezone: 'UTC',
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    status: 'open',
    notes: null,
    openedAt: `${TODAY_UTC}T12:00:00.000Z`,
    closedAt: null,
    createdAt: `${TODAY_UTC}T12:00:00.000Z`,
    updatedAt: `${TODAY_UTC}T13:00:00.000Z`,
    fills: [],
    avgEntryPrice: 150,
    avgExitPrice: 160,
    totalEntryQuantity: 100,
    totalExitQuantity: 40,
    realizedPnl: 0,
    returnPercentage: 0,
    brokerageName: null,
    grossPnl: 0,
    brokerageFees: 0,
    netPnl: 0,
    targetPrice: null,
    stopLoss: null,
    targetRR: null,
    actualRR: null,
    openUnits: 60,
    closedUnits: 40,
    ...overrides,
  } as PositionDetail;
}

function mockDetail(overrides: Partial<PositionDetail> = {}) {
  vi.mocked(usePosition).mockReturnValue({
    data: makeDetail(overrides),
    isLoading: false,
  } as unknown as PositionResult);
}

beforeEach(() => {
  localStorage.clear();
  // A user who has dismissed nothing: every reason the mark could withhold
  // itself for is off, so `available` is the only one left in play.
  const preference: OnboardingState = { status: 'active', coachMarksSeen: [] };
  mockQuery.mockReturnValue({ data: preference } as ReturnType<typeof useOnboardingQuery>);
  mockPatch.mockReturnValue({ mutate: vi.fn() } as unknown as ReturnType<
    typeof useOnboardingPatch
  >);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PositionDetail — the Fills coach mark follows the Add Fill button', () => {
  it('offers the mark on an open position, where Add Fill is on screen', () => {
    mockDetail({ status: 'open' });
    renderDetail();

    expect(screen.getByRole('button', { name: 'Add Fill' })).toBeTruthy();
    expect(screen.getByTestId('coach-mark-position-partials')).toBeTruthy();
  });

  it('offers it on a draft too — scaling in is what a draft is for', () => {
    mockDetail({ status: 'draft', totalExitQuantity: 0, openUnits: 100, closedUnits: 0 });
    renderDetail();

    expect(screen.getByRole('button', { name: 'Add Fill' })).toBeTruthy();
    expect(screen.getByTestId('coach-mark-position-partials')).toBeTruthy();
  });

  it('withholds it on a closed position, which has no Add Fill for it to introduce', () => {
    mockDetail({
      status: 'closed',
      closedAt: `${TODAY_UTC}T13:00:00.000Z`,
      totalExitQuantity: 100,
      openUnits: 0,
      closedUnits: 100,
    });
    const { container } = renderDetail();

    expect(screen.queryByRole('button', { name: 'Add Fill' })).toBeNull();
    expect(screen.queryByTestId('coach-mark-position-partials')).toBeNull();
    // Absent rather than hidden: `available` is checked before anything renders,
    // so not even the anchor reaches the Fills header.
    expect(container.querySelector('[data-slot="coach-mark-anchor"]')).toBeNull();
  });
});

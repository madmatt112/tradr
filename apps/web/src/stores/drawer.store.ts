import { create } from 'zustand';

export type DrawerTab = 'open-positions' | 'quick-stats' | 'options-pricing' | 'recently-created';

export const DRAWER_TABS: readonly DrawerTab[] = [
  'open-positions',
  'quick-stats',
  'options-pricing',
  'recently-created',
] as const;

export const DRAWER_STORAGE_KEY = 'tradr_drawer_state';

export interface PersistedDrawerState {
  isOpen: boolean;
  activeTab: DrawerTab;
  version: 1;
}

export interface DrawerStoreState {
  isOpen: boolean;
  activeTab: DrawerTab;
  legacyDetected: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setActiveTab: (tab: DrawerTab) => void;
}

function isDrawerTab(value: unknown): value is DrawerTab {
  return typeof value === 'string' && (DRAWER_TABS as readonly string[]).includes(value);
}

export function readDrawerState(): PersistedDrawerState | { _legacy: true } | null {
  if (typeof window === 'undefined') return null;

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(DRAWER_STORAGE_KEY);
  } catch {
    return null;
  }

  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const version = obj.version;

  if (typeof version !== 'number') return null;
  if (version < 1) return null;
  if (version > 1) return { _legacy: true };

  // version === 1: validate remaining fields.
  if (typeof obj.isOpen !== 'boolean') return null;
  if (!isDrawerTab(obj.activeTab)) return null;

  return {
    isOpen: obj.isOpen,
    activeTab: obj.activeTab,
    version: 1,
  };
}

export function writeDrawerState(state: Pick<DrawerStoreState, 'isOpen' | 'activeTab'>): void {
  if (useDrawerStore.getState().legacyDetected) return;
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({
        isOpen: state.isOpen,
        activeTab: state.activeTab,
        version: 1,
      }),
    );
  } catch {
    // SSR / quota-exceeded / serialization errors: no-op.
  }
}

function computeInitialState(): Pick<DrawerStoreState, 'isOpen' | 'activeTab' | 'legacyDetected'> {
  const persisted = readDrawerState();

  if (persisted === null) {
    return { isOpen: false, activeTab: 'open-positions', legacyDetected: false };
  }

  if ('_legacy' in persisted) {
    return { isOpen: false, activeTab: 'open-positions', legacyDetected: true };
  }

  return {
    isOpen: persisted.isOpen,
    activeTab: persisted.activeTab,
    legacyDetected: false,
  };
}

export const useDrawerStore = create<DrawerStoreState>((set) => {
  const initial = computeInitialState();

  return {
    isOpen: initial.isOpen,
    activeTab: initial.activeTab,
    legacyDetected: initial.legacyDetected,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
    toggle: () => set((s) => ({ isOpen: !s.isOpen })),
    setActiveTab: (tab) => {
      if (!isDrawerTab(tab)) return;
      set({ activeTab: tab });
    },
  };
});

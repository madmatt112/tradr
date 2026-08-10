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
  /**
   * Return the LIVE store to what a fresh page load with no stored state would
   * produce. Used by the session teardown (`lib/sessionTeardown`).
   *
   * The store hydrates from localStorage exactly once, when this module is
   * imported. Removing the stored key therefore does nothing to the values
   * already in memory, and logging in is a client-side navigation rather than a
   * page load: without this the next user on the tab keeps the last one's
   * drawer, and their first change persists it straight back.
   *
   * `legacyDetected` resets too. It latches on a stored state written by a
   * NEWER version of the app and exists to stop us overwriting it — and the
   * teardown removes that very key, so by the time this runs there is nothing
   * left to protect.
   */
  reset: () => void;
}

const DEFAULT_DRAWER_STATE: Pick<DrawerStoreState, 'isOpen' | 'activeTab' | 'legacyDetected'> = {
  isOpen: false,
  activeTab: 'open-positions',
  legacyDetected: false,
};

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
    return { ...DEFAULT_DRAWER_STATE };
  }

  if ('_legacy' in persisted) {
    return { ...DEFAULT_DRAWER_STATE, legacyDetected: true };
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
    reset: () => set({ ...DEFAULT_DRAWER_STATE }),
  };
});

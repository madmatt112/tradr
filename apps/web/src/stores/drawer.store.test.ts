// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DRAWER_STORAGE_KEY,
  readDrawerState,
  useDrawerStore,
  writeDrawerState,
} from './drawer.store';

describe('drawer.store', () => {
  beforeEach(() => {
    localStorage.clear();
    useDrawerStore.setState({
      isOpen: false,
      activeTab: 'open-positions',
      legacyDetected: false,
    });
  });

  it('open() sets isOpen to true', () => {
    useDrawerStore.getState().open();
    expect(useDrawerStore.getState().isOpen).toBe(true);
  });

  it('close() sets isOpen to false', () => {
    useDrawerStore.setState({ isOpen: true });
    useDrawerStore.getState().close();
    expect(useDrawerStore.getState().isOpen).toBe(false);
  });

  it('toggle() flips isOpen from false to true to false', () => {
    useDrawerStore.getState().toggle();
    expect(useDrawerStore.getState().isOpen).toBe(true);
    useDrawerStore.getState().toggle();
    expect(useDrawerStore.getState().isOpen).toBe(false);
  });

  it("setActiveTab('quick-stats') sets activeTab to 'quick-stats'", () => {
    useDrawerStore.getState().setActiveTab('quick-stats');
    expect(useDrawerStore.getState().activeTab).toBe('quick-stats');
  });

  // The session teardown's half of the drawer: the store hydrates from
  // localStorage once at import, so clearing the key without this leaves the
  // previous user's drawer live in memory (lib/sessionTeardown).
  it('reset() returns the store to what a fresh load with no stored state gives', () => {
    useDrawerStore.setState({
      isOpen: true,
      activeTab: 'quick-stats',
      // The latch exists to stop us overwriting a newer version's stored state,
      // and the teardown has just removed that state — nothing left to protect.
      legacyDetected: true,
    });

    useDrawerStore.getState().reset();

    expect(useDrawerStore.getState()).toMatchObject({
      isOpen: false,
      activeTab: 'open-positions',
      legacyDetected: false,
    });
  });

  it('writeDrawerState writes a v1 JSON object to localStorage', () => {
    writeDrawerState({ isOpen: true, activeTab: 'options-pricing' });
    const raw = localStorage.getItem(DRAWER_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.version).toBe(1);
    expect(parsed.isOpen).toBe(true);
    expect(parsed.activeTab).toBe('options-pricing');
  });

  it('readDrawerState returns parsed shape for valid v1 JSON', () => {
    localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({
        isOpen: true,
        activeTab: 'quick-stats',
        version: 1,
      }),
    );
    expect(readDrawerState()).toEqual({
      isOpen: true,
      activeTab: 'quick-stats',
      version: 1,
    });
  });

  it('readDrawerState returns null for malformed JSON', () => {
    localStorage.setItem(DRAWER_STORAGE_KEY, '{not json');
    expect(readDrawerState()).toBeNull();
  });

  it('readDrawerState returns { _legacy: true } for version: 2', () => {
    localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({ isOpen: true, activeTab: 'open-positions', version: 2 }),
    );
    expect(readDrawerState()).toEqual({ _legacy: true });
  });

  it('readDrawerState returns null for version: 0', () => {
    localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({ isOpen: true, activeTab: 'open-positions', version: 0 }),
    );
    expect(readDrawerState()).toBeNull();
  });

  it('readDrawerState returns null when isOpen is missing', () => {
    localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({ activeTab: 'open-positions', version: 1 }),
    );
    expect(readDrawerState()).toBeNull();
  });

  it("readDrawerState returns null for activeTab: 'invalid-tab'", () => {
    localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({ isOpen: true, activeTab: 'invalid-tab', version: 1 }),
    );
    expect(readDrawerState()).toBeNull();
  });

  it('writeDrawerState is a no-op when legacyDetected is true', () => {
    localStorage.setItem(DRAWER_STORAGE_KEY, 'sentinel');
    useDrawerStore.setState({ legacyDetected: true });
    writeDrawerState({ isOpen: true, activeTab: 'open-positions' });
    expect(localStorage.getItem(DRAWER_STORAGE_KEY)).toBe('sentinel');
  });

  it("readDrawerState returns null when version is the string '1'", () => {
    localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({ isOpen: true, activeTab: 'open-positions', version: '1' }),
    );
    expect(readDrawerState()).toBeNull();
  });
});

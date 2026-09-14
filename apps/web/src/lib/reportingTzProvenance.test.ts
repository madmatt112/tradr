// @vitest-environment jsdom
//
// The provenance record: "the stored reporting zone the app last reconciled the
// performance URL against". The durable tier is sessionStorage (so a reload
// still resyncs the calendar), with a module-level fallback only for when
// storage throws (Safari private mode). These tests cover that lifecycle.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTzProvenanceState,
  clearTzProvenance,
  readTzProvenance,
  writeTzProvenance,
} from './reportingTzProvenance';

const KEY = 'perf.tz_provenance';

beforeEach(() => {
  sessionStorage.clear();
  __resetTzProvenanceState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reportingTzProvenance', () => {
  it('reads null when nothing has been recorded', () => {
    expect(readTzProvenance()).toBeNull();
  });

  it('writes a zone that a later read returns, durable in sessionStorage', () => {
    writeTzProvenance('Europe/London');

    expect(readTzProvenance()).toBe('Europe/London');
    // The durable tier is sessionStorage, so the value survives a reload.
    expect(sessionStorage.getItem(KEY)).toBe('Europe/London');
  });

  it('clears the record', () => {
    writeTzProvenance('America/New_York');

    clearTzProvenance();

    expect(readTzProvenance()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('falls back to the in-memory record when setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    writeTzProvenance('Asia/Tokyo');

    // Nothing reached sessionStorage, but the read still returns the zone from
    // the module-level fallback.
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(readTzProvenance()).toBe('Asia/Tokyo');
  });
});

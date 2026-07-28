/**
 * Unit test for the pure gc age-floor derivation (no DB / no IO). The
 * migrate-to-inline + gc behaviours against a real Postgres live in
 * `storage-maintenance.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import { config } from '@/lib/config';

import { deriveGcAgeFloorMs } from './storage-maintenance.service';

describe('deriveGcAgeFloorMs (REQ-3.2)', () => {
  it('is derived from real config: max(stream timeout, reservation TTL) + a fixed margin', () => {
    const floor = deriveGcAgeFloorMs();
    // The floor MUST be at least the larger in-flight-turn bound, so a
    // put-before-commit object younger than a full turn is never reaped.
    const bound = Math.max(config.ADVISOR_STREAM_TIMEOUT_MS, config.RESERVATION_TTL_MS);
    expect(floor).toBeGreaterThan(bound);
    // Test env defaults: stream timeout 120_000, reservation TTL 600_000 → floor
    // is RESERVATION_TTL_MS + a 60_000 margin.
    expect(floor).toBe(config.RESERVATION_TTL_MS + 60_000);
  });
});

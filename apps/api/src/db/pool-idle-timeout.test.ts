/**
 * App-pool idle-connection recycling.
 *
 * postgres.js defaults `idle_timeout` to `null`, meaning idle connections are
 * never closed. A pool that holds them indefinitely will, after the host
 * suspends or a pooler reaps the backend, resume with sockets the server has
 * already dropped — and the next query blocks on TCP retransmit instead of
 * dialing fresh. The app pool must therefore set the option explicitly.
 */
import postgres from 'postgres';
import { describe, it, expect } from 'vitest';

import { sql } from '@/db';

describe('app-pool idle timeout', () => {
  it('closes idle connections instead of holding them open forever', () => {
    expect(sql.options.idle_timeout).toBe(60);
  });

  it('pins the postgres.js default the option exists to override', async () => {
    const bare = postgres('postgresql://user:pass@localhost:5432/db', { max: 10 });
    try {
      expect(bare.options.idle_timeout).toBeNull();
    } finally {
      await bare.end({ timeout: 0 });
    }
  });
});

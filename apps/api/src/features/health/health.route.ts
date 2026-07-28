import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '@/db';
import { config } from '@/lib/config';

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Liveness probe (DB connectivity) plus the deployed version.
 *     description: >
 *       Runs `SELECT 1` against the database. `version` is the deployed version
 *       string (e.g. `v0.2.0-f51f9f5`) baked into the image at build time via
 *       the APP_VERSION env; the field is omitted where unset (local dev).
 *     tags: [Platform]
 *     responses:
 *       200: { description: '{ status: "ok", version? }' }
 *       503: { description: '{ status: "error", version? } — DB unreachable.' }
 */
const app = new Hono().get('/', async (c) => {
  const version = config.APP_VERSION ? { version: config.APP_VERSION } : {};
  try {
    await db.execute(sql`SELECT 1`);
    return c.json({ status: 'ok', ...version });
  } catch {
    return c.json({ status: 'error', ...version }, 503);
  }
});

export default app;
